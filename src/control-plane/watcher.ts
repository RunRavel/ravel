import chokidar, { type FSWatcher, type ChokidarOptions } from "chokidar";
import { EventEmitter } from "node:events";
import { compileRegistry, type CompileResult, type RegistrySnapshot, type Diagnostic } from "./registry.js";

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
  private version = 0;
  private lastGood: RegistrySnapshot | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private compiling = false;
  private pending = false;

  constructor(root: string, opts: { debounceMs?: number; watchOptions?: Partial<ChokidarOptions> } = {}) {
    super();
    this.root = root;
    this.debounceMs = opts.debounceMs ?? 150;
    // Polling is more reliable than fsevents/inotify under heavy parallel load
    // (e.g. test workers) and across network/container filesystems. Callers can
    // opt into it; the default uses the native backend for efficiency.
    this.watchOptions = opts.watchOptions ?? {};
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
      ignored: (p: string) => /(^|[/\\])(node_modules|\.git|\.businessos)([/\\]|$)/.test(p),
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
