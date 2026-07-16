import path from "node:path";
import { promises as fs } from "node:fs";
import type { ChokidarOptions } from "chokidar";
import { RegistryWatcher } from "../control-plane/watcher.js";
import type { RegistrySnapshot, Diagnostic } from "../control-plane/registry.js";
import { lintRegistry } from "../control-plane/lint.js";
import { Lifecycle } from "../runtime/lifecycle.js";
import type { AgentEngine } from "../runtime/engine.js";
import { Orchestrator, type ProcessRunResult } from "../orchestrator/orchestrator.js";
import { EnginePlanner } from "../orchestrator/planner.js";
import { MessageBus } from "../messaging/bus.js";
import { MemoryStore } from "../memory/store.js";
import { JsonlAudit, LoggingAudit, type AuditSink } from "../trust/audit.js";
import { ApprovalBroker, type ApprovalMode } from "../trust/approval.js";
import { ProposalStore } from "../trust/proposals.js";
import { ActionExecutor } from "../trust/executor.js";
import { KillSwitch } from "../trust/killswitch.js";
import { Observer, type DashboardSnapshot } from "../trust/observability.js";
import { OFFICE_TOOL_NAMES, runOfficeAction } from "../runtime/officeActions.js";
import { PluginRegistry } from "../plugins/loader.js";
import { SecretStore } from "../secrets/store.js";
import type { PermissionDecision, ApprovalRequest, Proposal } from "../domain/types.js";

export interface AppOptions {
  /** Org root folder (must contain the top-level agent.md). */
  root: string;
  /** LLM backend. Use SdkEngine in production, a fake in tests. */
  engine: AgentEngine;
  /** Inject an audit sink; defaults to a JSONL file under the runtime dir. */
  audit?: AuditSink;
  /** Dry-run: agents produce intended actions but execute no tools. */
  dryRun?: boolean;
  /** Tee every audit event to this sink (e.g. stderr) for live verbose logging. */
  verbose?: (line: string) => void;
  /** Where runtime state (working dirs, inboxes, memory, audit) lives. */
  runtimeDir?: string;
  /** Persist inboxes to disk under the runtime dir. */
  persistMessages?: boolean;
  /** Approval mode: "deferred" (default — async proposals) or "sync" (blocking, interactive). */
  approvals?: ApprovalMode;
  watchOptions?: Partial<ChokidarOptions>;
}

/**
 * The Ravel runtime. Wires the control plane (watcher → lifecycle),
 * execution (orchestrator + agent runtimes), messaging (bus + inboxes),
 * memory, and the trust layer (audit, approvals, kill switch, observability)
 * into one object the owner drives.
 */
export class App {
  readonly audit: AuditSink;
  readonly approvals: ApprovalBroker;
  readonly proposals: ProposalStore;
  readonly executor: ActionExecutor;
  readonly killSwitch: KillSwitch;
  readonly lifecycle: Lifecycle;
  readonly bus: MessageBus;
  readonly memory: MemoryStore;
  readonly orchestrator: Orchestrator;
  readonly observer: Observer;
  /** Loaded team plugins (in-process code tools scoped per team). */
  readonly plugins: PluginRegistry;
  /** Per-node credential resolver (each agent's `.env` chain). */
  readonly secrets: SecretStore;
  /** Plugin executor actions already registered (idempotent across snapshot applies). */
  private readonly registeredPluginActions = new Set<string>();
  /** Where runtime state (working dirs, runs, proposals, audit) lives. */
  readonly runtimeDir: string;
  /** Org root folder. */
  readonly root: string;

  private readonly watcher: RegistryWatcher;
  private snapshot: RegistrySnapshot | null = null;
  private applyChain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: AppOptions) {
    const runtimeDir = opts.runtimeDir ?? path.join(opts.root, ".ravel");
    this.runtimeDir = runtimeDir;
    this.root = opts.root;
    const baseAudit = opts.audit ?? new JsonlAudit(path.join(runtimeDir, "audit.jsonl"));
    this.audit = opts.verbose ? new LoggingAudit(baseAudit, opts.verbose) : baseAudit;
    this.proposals = new ProposalStore({ filePath: path.join(runtimeDir, "proposals.json") });
    this.approvals = new ApprovalBroker(this.audit, {
      mode: opts.approvals ?? "deferred",
      proposals: this.proposals,
      ...(opts.dryRun ? { dryRun: true } : {}),
    });
    // The executor performs approved proposed actions deterministically.
    this.executor = new ActionExecutor(this.audit);
    for (const action of OFFICE_TOOL_NAMES) {
      this.executor.register(action, (input, ctx) => runOfficeAction(action, input, ctx));
    }
    this.killSwitch = new KillSwitch();
    this.bus = new MessageBus({
      audit: this.audit,
      ...(opts.persistMessages ? { messagesDir: path.join(runtimeDir, "messages") } : {}),
    });
    this.memory = new MemoryStore(path.join(runtimeDir, "memory"));
    this.plugins = new PluginRegistry(this.root, this.audit);
    this.secrets = new SecretStore(this.root);
    this.lifecycle = new Lifecycle({
      engine: opts.engine,
      audit: this.audit,
      approvals: this.approvals,
      killSwitch: this.killSwitch,
      workdirRoot: path.join(runtimeDir, "agents"),
      memory: this.memory,
      plugins: this.plugins,
      secrets: this.secrets,
    });
    this.orchestrator = new Orchestrator({
      lifecycle: this.lifecycle,
      planner: new EnginePlanner((id) => this.lifecycle.get(id)),
      audit: this.audit,
      workspaceRoot: path.join(runtimeDir, "runs"),
    });
    this.observer = new Observer(this.audit, this.lifecycle, this.proposals, () => this.bus.deadLetters.length);

    this.watcher = new RegistryWatcher(opts.root, {
      ...(opts.watchOptions ? { watchOptions: opts.watchOptions } : {}),
    });
    this.watcher.on("snapshot", (snap) => this.enqueueApply(snap));
    this.watcher.on("invalid", (diags: Diagnostic[]) => {
      void this.audit.append("registry.invalid", {
        data: { diagnostics: diags.map((d) => `${d.where}: ${d.message}`) },
      });
    });
  }

  /**
   * One-time state-dir migration: the runtime dir was `.businessos` before 0.1.
   * Fires only when this app uses the DEFAULT state location — a custom
   * runtimeDir (e.g. `--state-dir`) is the caller's business. Must run before
   * any store touches disk; returns whether a rename happened so the audit
   * event can be appended after the log is loaded (appending first would
   * double-count it on rehydrate).
   */
  private async migrateLegacyStateDir(): Promise<boolean> {
    if (path.resolve(this.runtimeDir) !== path.resolve(this.root, ".ravel")) return false;
    const legacy = path.join(this.root, ".businessos");
    const exists = (p: string) => fs.stat(p).then(() => true, () => false);
    if (!(await exists(legacy)) || (await exists(this.runtimeDir))) return false;
    await fs.rename(legacy, this.runtimeDir);
    return true;
  }

  /** Compile the org, spawn agents, and begin watching for edits. */
  async start(): Promise<void> {
    const migrated = await this.migrateLegacyStateDir();
    // Rehydrate durable state so runs, chats, proposals, and spend survive restarts.
    await this.audit.load?.();
    await this.proposals.load();
    if (migrated) {
      await this.audit.append("state.migrated", { data: { from: ".businessos", to: ".ravel" } });
    }
    const initial = await this.watcher.start();
    if (!initial.ok || !initial.snapshot) {
      const detail = initial.diagnostics.map((d) => `${d.where}: ${d.message}`).join("; ");
      throw new Error(`org failed to compile: ${detail}`);
    }
    // watcher.start() already emitted this snapshot → an apply is queued on
    // applyChain. Enqueue-and-await (rather than a second, concurrent direct
    // apply) so the initial apply — plugin load + action registration — is fully
    // settled before start() returns, with no race on the two applies.
    this.enqueueApply(initial.snapshot);
    await this.applyChain;
    // Plugins are now loaded → run the advisory lint with full context (real
    // plugin tool names + per-node .env chains) and surface warnings without
    // blocking startup. Config errors already threw above; these never do.
    await this.lintAndReport();
  }

  /**
   * Advisory config lint at startup — generic-mem-write, missing/undeclared env,
   * and dead tool grants. Emits each as a non-fatal `config.warning` audit event
   * (tee'd to the verbose sink under `-v`). Never throws.
   */
  private async lintAndReport(): Promise<void> {
    if (!this.snapshot) return;
    try {
      const warnings = await lintRegistry(this.snapshot, {
        secrets: this.secrets,
        pluginToolNamesByNode: (nodeId) => (this.plugins.forNode(nodeId)?.tools ?? []).map((t) => t.name),
      });
      for (const w of warnings) {
        await this.audit.append("config.warning", { data: { where: w.where, message: w.message } });
      }
    } catch {
      /* lint is best-effort; never block or crash startup on it */
    }
  }

  async stop(): Promise<void> {
    await this.watcher.stop();
    await this.applyChain; // let any in-flight reconciliation finish
  }

  private enqueueApply(snap: RegistrySnapshot): void {
    this.applyChain = this.applyChain.then(() => this.apply(snap)).catch(() => undefined);
  }

  private async apply(snap: RegistrySnapshot): Promise<void> {
    this.snapshot = snap;
    this.bus.updateTopology(snap);
    // Load any new team plugins, then register their gated executor actions
    // (before agents run, so an approved proposal has a handler waiting).
    await this.plugins.syncFromSnapshot(snap);
    await this.registerPluginActions();
    await this.lifecycle.applySnapshot(snap);
  }

  /** Register each loaded plugin's actions on the executor, once per action name. */
  private async registerPluginActions(): Promise<void> {
    for (const { nodeId, plugin } of this.plugins.all()) {
      for (const action of plugin.actions ?? []) {
        if (this.registeredPluginActions.has(action.name)) continue;
        if (this.executor.has(action.name)) {
          await this.audit.append("plugin.action_conflict", {
            nodeId,
            data: { action: action.name, plugin: plugin.name },
          });
          continue;
        }
        const memory = this.memory;
        this.executor.register(action.name, async (input, ctx) =>
          action.handler(input, {
            ...ctx,
            memory,
            ...(ctx.managerNodeId !== undefined ? { teamScope: { kind: "team" as const, managerNodeId: ctx.managerNodeId } } : {}),
          }),
        );
        this.registeredPluginActions.add(action.name);
      }
    }
  }

  currentSnapshot(): RegistrySnapshot | null {
    return this.snapshot;
  }

  /**
   * Run a named process (a playbook). Optionally pass run inputs (e.g. a
   * prospect name, target languages) and source files (absolute host paths)
   * that get staged into each dispatched worker's working directory.
   */
  async runProcess(
    name: string,
    run: { inputs?: Record<string, unknown>; files?: string[]; runId?: string } = {},
  ): Promise<ProcessRunResult> {
    if (!this.snapshot) throw new Error("platform not started");
    const proc = this.snapshot.processes.find((p) => p.spec.name === name);
    if (!proc) {
      const available = this.snapshot.processes.map((p) => p.spec.name).join(", ") || "(none)";
      throw new Error(`no process named "${name}". Available: ${available}`);
    }
    return this.orchestrator.runProcess(proc, this.snapshot, run);
  }

  /** Chat directly with one agent by node id. */
  async chat(nodeId: string, message: string): Promise<string> {
    const agent = this.lifecycle.get(nodeId);
    if (!agent) throw new Error(`no agent at node "${nodeId}"`);
    return agent.chat(message);
  }

  /** Sync-mode blocking approvals (interactive CLI). Empty in deferred mode. */
  pendingApprovals(): ApprovalRequest[] {
    return this.approvals.pending();
  }

  async resolveApproval(id: string, decision: PermissionDecision): Promise<boolean> {
    return this.approvals.resolve(id, decision);
  }

  /** Deferred-mode proposals awaiting an async human decision. */
  pendingProposals(): Proposal[] {
    return this.proposals.pending();
  }

  /**
   * Resolve a deferred proposal. On approve, the executor performs the action
   * (deterministically — no model call) and the proposal is marked executed/failed;
   * on reject, it's marked rejected and nothing runs.
   */
  async resolveProposal(id: string, decision: "approve" | "reject"): Promise<Proposal | null> {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== "pending") return null;

    if (decision === "reject") {
      return this.proposals.setStatus(id, "rejected");
    }
    await this.proposals.setStatus(id, "approved");
    const result = await this.executor.execute(proposal);
    return this.proposals.setStatus(id, result.ok ? "executed" : "failed", {
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
  }

  /** Halt a scope: an agent id, a subtree prefix, or "*" for the whole org. */
  kill(scope: string): number {
    return this.killSwitch.kill(scope);
  }

  clearKill(scope: string): void {
    this.killSwitch.clear(scope);
  }

  dashboard(): DashboardSnapshot {
    return this.observer.snapshot();
  }
}
