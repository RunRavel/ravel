import chokidar, { type FSWatcher, type ChokidarOptions } from "chokidar";
import path from "node:path";
import { realpathSync } from "node:fs";
import { EventEmitter } from "node:events";
import { compileRegistry, type CompileResult, type RegistrySnapshot, type Diagnostic } from "./registry.js";

/**
 * Resolve `p` through symlinks. A watched path may not exist (a delete event),
 * so resolve the deepest existing ancestor and re-append the missing tail —
 * enough to tell whether the *real* location is inside the state dir or escapes
 * the repo, regardless of watch backend.
 */
function realResolve(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs; // reached fs root without resolving
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

const isUnder = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + path.sep);

export interface WatcherEvents {
  /** A new valid snapshot was compiled and is now current. */
  snapshot: (snapshot: RegistrySnapshot) => void;
  /** A compile failed; the previous snapshot (if any) stays current. */
  invalid: (diagnostics: Diagnostic[], lastGood: RegistrySnapshot | null) => void;
}

/**
 * Watches an org folder and compiles it into versioned snapshots on change.
 *
 * Design choices that follow from the architecture:
 * - The folder is the *authoring source of truth*; this watcher is the
 *   compile step that turns it into a runtime artifact. Nothing mutates a
 *   running agent directly.
 * - Versions are monotonic and owned here, so downstream (lifecycle) can diff.
 * - A failed compile never clobbers the last-good snapshot — invalid trees are
 *   surfaced as diagnostics and the running org keeps going.
 * - Changes are debounced so a multi-file save produces one recompile.
 */
export class RegistryWatcher extends EventEmitter {
  private readonly root: string;
  private readonly debounceMs: number;
  private readonly watchOptions: Partial<ChokidarOptions>;
  /** Realpath of the watched root — the boundary the config plane must stay within. */
  private readonly rootReal: string;
  /** Realpath of the runtime/state dir to ignore, if any (see `isIgnored`). */
  private readonly runtimeDirReal: string | null;
  private version = 0;
  private lastGood: RegistrySnapshot | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private compiling = false;
  private pending = false;

  constructor(
    root: string,
    opts: { debounceMs?: number; watchOptions?: Partial<ChokidarOptions>; runtimeDir?: string } = {},
  ) {
    super();
    this.root = root;
    this.debounceMs = opts.debounceMs ?? 150;
    // Polling is more reliable than fsevents/inotify under heavy parallel load
    // (e.g. test workers) and across network/container filesystems. Callers can
    // opt into it; the default uses the native backend for efficiency.
    this.watchOptions = opts.watchOptions ?? {};
    this.rootReal = realResolve(root);
    // The runtime/state dir (memory, audit, runs, proposals) lives at
    // `<root>/.ravel` by default — i.e. inside the watched tree — so agent
    // memory writes would otherwise look like config edits and force a recompile
    // on every write. Ignore it by RESOLVED PATH, not name: a hardcoded `.ravel`
    // breaks on the next rename and misses a `--state-dir` inside root.
    this.runtimeDirReal = opts.runtimeDir ? realResolve(opts.runtimeDir) : null;
  }

  /**
   * Whether the watcher should ignore a path. Beyond VCS/deps, ignore anything
   * whose REAL (symlink-resolved) location is the state dir or escapes the repo
   * — so agent memory writes never look like config edits, and a symlink out of
   * the checkout (e.g. to a hosted `--state-dir`) can't drag external writes in.
   * Realpath-based so it holds on both the native and polling watch backends.
   */
  private isIgnored(p: string): boolean {
    if (/(^|[/\\])(node_modules|\.git)([/\\]|$)/.test(p)) return true;
    const real = realResolve(p);
    if (this.runtimeDirReal && isUnder(real, this.runtimeDirReal)) return true;
    if (!isUnder(real, this.rootReal)) return true; // symlink escape
    return false;
  }

  /** Compile once without starting the watcher. Returns the result. */
  async compileOnce(): Promise<CompileResult> {
    const result = await compileRegistry(this.root, this.version + 1);
    if (result.ok && result.snapshot) {
      this.version = result.snapshot.version;
      this.lastGood = result.snapshot;
    }
    return result;
  }

  /** Current last-good snapshot, or null if nothing has compiled cleanly yet. */
  current(): RegistrySnapshot | null {
    return this.lastGood;
  }

  /** Start watching. Performs an initial compile, then recompiles on changes. */
  async start(): Promise<CompileResult> {
    const initial = await this.compileOnce();
    this.emitResult(initial);

    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      // Don't follow symlinks out of the repo (perf + correctness on the native
      // backend); `isIgnored` is the backend-independent guarantee.
      followSymlinks: false,
      ignored: (p: string) => this.isIgnored(p),
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      ...this.watchOptions,
    });

    const schedule = () => this.scheduleRecompile();
    this.watcher.on("add", schedule);
    this.watcher.on("change", schedule);
    this.watcher.on("unlink", schedule);
    this.watcher.on("addDir", schedule);
    this.watcher.on("unlinkDir", schedule);

    // Wait until the initial scan completes so the watch is actually armed
    // before we return — otherwise a change made immediately after start() can
    // race the watcher's setup and be missed.
    await new Promise<void>((resolve) => {
      this.watcher!.once("ready", () => resolve());
    });

    return initial;
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.watcher?.close();
    this.watcher = null;
  }

  private scheduleRecompile(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.recompile(), this.debounceMs);
  }

  private async recompile(): Promise<void> {
    // Serialize compiles; coalesce changes that arrive mid-compile into one
    // follow-up pass so we never miss the latest state.
    if (this.compiling) {
      this.pending = true;
      return;
    }
    this.compiling = true;
    try {
      const result = await compileRegistry(this.root, this.version + 1);
      if (result.ok && result.snapshot) {
        this.version = result.snapshot.version;
        this.lastGood = result.snapshot;
      }
      this.emitResult(result);
    } finally {
      this.compiling = false;
      if (this.pending) {
        this.pending = false;
        this.scheduleRecompile();
      }
    }
  }

  private emitResult(result: CompileResult): void {
    if (result.ok && result.snapshot) {
      this.emit("snapshot", result.snapshot);
    } else {
      this.emit("invalid", result.diagnostics, this.lastGood);
    }
  }
}
