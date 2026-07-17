import { promises as fs } from "node:fs";
import path from "node:path";
import { parseAgentSpec, type AgentSpec } from "../schemas/agent.js";
import { parseToolsConfig, EMPTY_TOOLS_CONFIG, type ToolsConfig } from "../schemas/tools.js";
import { parseProcessSpec, type ProcessSpec } from "../schemas/process.js";
import { parseManifest, type Manifest } from "../schemas/manifest.js";

/**
 * The compiled, immutable representation of one agent folder.
 *
 * Folder position defines the *escalation/permission tree* (parent ← manager,
 * children → direct reports), not the execution flow. Execution is driven by
 * processes and the orchestrator. `id` is a stable, path-derived identifier so
 * the same folder keeps the same id across recompiles.
 */
export interface RegistryNode {
  /** Stable id derived from the path relative to the org root (POSIX slashes). Root is "". */
  id: string;
  /** Absolute path to the agent folder. */
  dir: string;
  spec: AgentSpec;
  tools: ToolsConfig;
  parentId: string | null;
  childIds: string[];
  /** Processes authored at this node's `processes/` directory. */
  processes: ProcessSpec[];
  /**
   * Root-relative path to this node's `plugin.ts`, if present. Compile only
   * RECORDS the path — it never imports team code. The platform loads it later.
   */
  pluginPath?: string;
}

/** A process plus the node id that owns its execution. */
export interface RegistryProcess {
  spec: ProcessSpec;
  /** Node that authored the process file. */
  definedAtNodeId: string;
  /** Node resolved from `spec.owner` that will decompose & dispatch it. */
  ownerNodeId: string;
  /** The process file's path, relative to the org root (for the config editor). */
  path: string;
}

export interface Diagnostic {
  /** Path (file or dir) the problem relates to, relative to the org root. */
  where: string;
  message: string;
  /**
   * Absence means "error" (the historical behavior — any diagnostic fails the
   * compile). Only an explicit `"warning"` is advisory and non-fatal; it's
   * surfaced by `validate`/`serve` but never blocks compilation. Warnings are
   * produced by the lint pass (`lint.ts`), not by the structural compiler.
   */
  severity?: "error" | "warning";
  /**
   * Stable machine-readable identifier for the check that produced this
   * diagnostic (e.g. "memory-write", "env-missing"). Lets CLI output group
   * near-duplicate messages and lets API/JSON consumers key off a code instead
   * of parsing prose. Only set by the lint pass; the structural compiler's
   * errors don't have one (each is already a distinct, specific problem).
   */
  code?: string;
}

/**
 * An immutable snapshot of the whole org. The watcher builds a new snapshot on
 * every change; the lifecycle manager diffs snapshots to drain/spawn agents.
 * Editing a folder never mutates a running agent directly — it produces a new
 * snapshot that is swapped in deliberately.
 */
export interface RegistrySnapshot {
  /** Monotonic version assigned by the compiler caller. */
  version: number;
  /** Absolute org root path. */
  root: string;
  rootId: string;
  nodes: ReadonlyMap<string, RegistryNode>;
  /** All processes across the org, with owners resolved. */
  processes: readonly RegistryProcess[];
  /** The parsed `ravel.json` manifest, if the org root has one. */
  manifest?: Manifest;
}

export interface CompileResult {
  ok: boolean;
  snapshot: RegistrySnapshot | null;
  diagnostics: Diagnostic[];
}

const AGENT_FILE = "agent.md";
const TOOLS_FILE = "tools.json";
const PROCESS_DIR = "processes";
const PROCESS_SUFFIX = ".process.md";
const PLUGIN_FILE = "plugin.ts";
const MANIFEST_FILE = "ravel.json";

function toNodeId(root: string, dir: string): string {
  const rel = path.relative(root, dir);
  return rel.split(path.sep).join("/"); // "" for root
}

function describeError(err: unknown): string {
  if (err && typeof err === "object" && "issues" in err) {
    // ZodError — flatten to a compact, readable list.
    const issues = (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues;
    return issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

/** Is this directory an agent node? (contains an agent.md) */
async function hasAgentFile(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, AGENT_FILE));
    return true;
  } catch {
    return false;
  }
}

interface ScanContext {
  root: string;
  nodes: Map<string, RegistryNode>;
  diagnostics: Diagnostic[];
  /** definedAt + spec, owner resolved in a second pass once all nodes exist. */
  pendingProcesses: Array<{ spec: ProcessSpec; definedAtNodeId: string; where: string }>;
}

async function readProcesses(
  dir: string,
  ctx: ScanContext,
  nodeId: string,
): Promise<ProcessSpec[]> {
  const procDir = path.join(dir, PROCESS_DIR);
  let entries: string[];
  try {
    entries = (await fs.readdir(procDir)).filter((f) => f.endsWith(PROCESS_SUFFIX));
  } catch {
    return []; // no processes/ dir is fine
  }
  entries.sort(); // deterministic ordering — stable cache keys downstream
  const result: ProcessSpec[] = [];
  for (const file of entries) {
    const full = path.join(procDir, file);
    const rel = toNodeId(ctx.root, full);
    try {
      const spec = parseProcessSpec(await fs.readFile(full, "utf8"));
      result.push(spec);
      ctx.pendingProcesses.push({ spec, definedAtNodeId: nodeId, where: rel });
    } catch (err) {
      ctx.diagnostics.push({ where: rel, message: describeError(err) });
    }
  }
  return result;
}

async function scanNode(
  dir: string,
  parentId: string | null,
  ctx: ScanContext,
): Promise<string | null> {
  const id = toNodeId(ctx.root, dir);
  const relDir = id || ".";

  // Parse agent.md
  let spec: AgentSpec;
  try {
    spec = parseAgentSpec(await fs.readFile(path.join(dir, AGENT_FILE), "utf8"));
  } catch (err) {
    ctx.diagnostics.push({ where: path.join(relDir, AGENT_FILE), message: describeError(err) });
    return null; // node invalid; do not register
  }

  // Parse tools.json (optional)
  let tools: ToolsConfig = EMPTY_TOOLS_CONFIG;
  try {
    const raw = await fs.readFile(path.join(dir, TOOLS_FILE), "utf8");
    tools = parseToolsConfig(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      ctx.diagnostics.push({ where: path.join(relDir, TOOLS_FILE), message: describeError(err) });
      // Tools invalid is a hard error for the node — running with the wrong
      // permission surface is unsafe. Drop the node.
      return null;
    }
  }

  const processes = await readProcesses(dir, ctx, id);

  // Detect an optional team plugin (record its path only; never import at compile).
  let pluginPath: string | undefined;
  try {
    await fs.access(path.join(dir, PLUGIN_FILE));
    pluginPath = toNodeId(ctx.root, path.join(dir, PLUGIN_FILE)); // root-relative
  } catch {
    /* no plugin.ts — fine */
  }

  // Recurse into child folders that contain an agent.md.
  const childIds: string[] = [];
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const childDirs = dirents
    .filter((d) => d.isDirectory() && d.name !== PROCESS_DIR && !d.name.startsWith("."))
    .map((d) => path.join(dir, d.name))
    .sort(); // deterministic

  // Register this node before recursing so children can reference parentId.
  ctx.nodes.set(id, { id, dir, spec, tools, parentId, childIds, processes, ...(pluginPath ? { pluginPath } : {}) });

  for (const child of childDirs) {
    if (await hasAgentFile(child)) {
      const childId = await scanNode(child, id, ctx);
      if (childId !== null) childIds.push(childId);
    }
  }
  return id;
}

/**
 * Resolve a process's `owner` role string to a node id.
 * Resolution order (first match wins, case-insensitive): node id, role, name.
 * The owner must be the defining node or one of its descendants — a process
 * cannot dispatch work to an unrelated branch of the org.
 */
function resolveOwner(
  ownerRef: string,
  definedAtNodeId: string,
  nodes: Map<string, RegistryNode>,
): { ok: true; nodeId: string } | { ok: false; reason: string } {
  const needle = ownerRef.trim().toLowerCase();
  const inScope = (id: string): boolean =>
    id === definedAtNodeId ||
    id.startsWith(definedAtNodeId === "" ? "" : `${definedAtNodeId}/`);

  const matches: string[] = [];
  for (const node of nodes.values()) {
    if (!inScope(node.id)) continue;
    const candidates = [node.id, node.spec.role ?? "", node.spec.name].map((s) =>
      s.toLowerCase(),
    );
    if (candidates.includes(needle)) matches.push(node.id);
  }

  if (matches.length === 0) {
    return { ok: false, reason: `owner "${ownerRef}" did not resolve to any agent in scope` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `owner "${ownerRef}" is ambiguous (matched ${matches.join(", ")})`,
    };
  }
  return { ok: true, nodeId: matches[0]! };
}

/**
 * Compile an org folder tree into an immutable RegistrySnapshot.
 *
 * On any validation error the result is `ok: false` with diagnostics and a
 * null snapshot — the caller keeps the last-good snapshot live. The `version`
 * is supplied by the caller (the watcher owns the monotonic counter).
 */
export async function compileRegistry(root: string, version: number): Promise<CompileResult> {
  const absRoot = path.resolve(root);
  const diagnostics: Diagnostic[] = [];

  if (!(await hasAgentFile(absRoot))) {
    diagnostics.push({
      where: ".",
      message: `org root has no ${AGENT_FILE} — the root folder must define the top-level agent`,
    });
    return { ok: false, snapshot: null, diagnostics };
  }

  // Optional team manifest (ravel.json). Absent is fine; malformed is an error.
  let manifest: Manifest | undefined;
  try {
    const raw = await fs.readFile(path.join(absRoot, MANIFEST_FILE), "utf8");
    manifest = parseManifest(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push({ where: MANIFEST_FILE, message: describeError(err) });
    }
  }

  const ctx: ScanContext = { root: absRoot, nodes: new Map(), diagnostics, pendingProcesses: [] };
  const rootId = await scanNode(absRoot, null, ctx);

  if (rootId === null) {
    return { ok: false, snapshot: null, diagnostics };
  }

  // Second pass: resolve process owners now that all nodes exist.
  const processes: RegistryProcess[] = [];
  for (const pending of ctx.pendingProcesses) {
    const resolved = resolveOwner(pending.spec.owner, pending.definedAtNodeId, ctx.nodes);
    if (!resolved.ok) {
      diagnostics.push({ where: pending.where, message: resolved.reason });
      continue;
    }
    processes.push({
      spec: pending.spec,
      definedAtNodeId: pending.definedAtNodeId,
      ownerNodeId: resolved.nodeId,
      path: pending.where,
    });
  }

  // Only errors (absent severity, or explicit "error") fail the compile;
  // "warning" diagnostics are advisory and never block a snapshot. The
  // structural compiler emits errors only — warnings come from the lint pass —
  // but the check is severity-aware so a snapshot can carry warnings if merged.
  const hasError = diagnostics.some((d) => d.severity !== "warning");
  if (hasError) {
    return { ok: false, snapshot: null, diagnostics };
  }

  const snapshot: RegistrySnapshot = {
    version,
    root: absRoot,
    rootId,
    nodes: ctx.nodes,
    processes,
    ...(manifest ? { manifest } : {}),
  };
  return { ok: true, snapshot, diagnostics };
}
