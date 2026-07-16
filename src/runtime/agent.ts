import { promises as fs } from "node:fs";
import path from "node:path";
import type { RegistryNode } from "../control-plane/registry.js";
import { resolveModel, type ModelTier, type Budget } from "../schemas/common.js";
import { policyForTool, SAFE_AUTO_TOOLS, type ApprovalBroker } from "../trust/approval.js";
import { BUILTIN_TOOLS } from "../schemas/catalog.js";
import type { ToolsConfig } from "../schemas/tools.js";
import type { MemoryStore } from "../memory/store.js";
import type { PluginRegistry } from "../plugins/loader.js";
import type { SecretStore } from "../secrets/store.js";
import { BudgetMeter } from "../trust/budget.js";
import type { KillSwitch } from "../trust/killswitch.js";
import type { AuditSink } from "../trust/audit.js";
import { systemClock, type Clock } from "../domain/ids.js";
import { emptyUsage, type TaskContract, type TaskResult, type TaskStatus, type Usage } from "../domain/types.js";
import type { AgentEngine, EngineRequest } from "./engine.js";

export type AgentState = "idle" | "running" | "draining" | "killed";

/**
 * Live, in-memory snapshot of what an agent is doing right now — surfaced to the
 * operator console so a run isn't an opaque "running". Reset to {} when idle.
 */
export interface AgentActivity {
  /** Goal of the task currently in flight (or chat/planning). */
  taskGoal?: string;
  /** The tool the agent most recently asked to use. */
  currentTool?: string;
  /** True while a tool call sits in the human-approval queue. */
  waitingOnApproval?: boolean;
  /** ISO time the current activity began. */
  since?: string;
}

/** Cheap read-only set so an agent can always read its staged files / working dir. */
const READONLY_TOOLS = SAFE_AUTO_TOOLS;
/**
 * Internal SDK turn caps — a *backstop* against a runaway agent loop, not a cost
 * leash. Real cost is bounded by the token/$ budget (which aborts via onUsage)
 * and prompt caching, so these are set generously: a worker that reads inputs,
 * writes a couple of artifacts, and verifies needs well more than a handful of
 * turns, and cutting it off mid-work surfaces as a spurious `error_max_turns`.
 */
const WORKER_MAX_TURNS = 45;
// Planning is mostly pure reasoning, but a manager may make a few read calls
// before emitting its plan. Keep enough headroom that it never runs out mid-plan
// (the old cap of 6 let a manager exhaust turns on inspection and emit nothing).
const PLANNING_MAX_TURNS = 12;
// Direct chat with a worker can ask it to actually do its job (search, dedup,
// record), not just answer — so it needs a worker-class budget, not the planner's.
// At the planner cap (12) a tool-heavy agent exhausts turns and returns
// error_max_turns mid-workflow.
const CHAT_MAX_TURNS = WORKER_MAX_TURNS;

/**
 * Decide which built-in SDK tools to expose for a call. Heavy tools (Bash,
 * Edit, WebSearch, …) are off unless the agent explicitly grants them by name
 * in tools.json — this is the primary lever on per-call token cost.
 */
function builtinToolsFor(tools: ToolsConfig, allowRead: boolean): string[] {
  // `builtins: "none"` withholds the read-only file tools entirely — for
  // memory-only agents that have no files and would otherwise loop on Grep/Read.
  const seedRead = allowRead && tools.builtins !== "none";
  const set = new Set<string>(seedRead ? READONLY_TOOLS : []);
  for (const grant of tools.tools) {
    if (grant.policy === "deny") continue;
    const match = BUILTIN_TOOLS.find((b) => b.toLowerCase() === grant.name.toLowerCase());
    if (match) set.add(match);
  }
  return [...set];
}

/** Raw outcome of one engine execution, before task/chat-specific framing. */
export interface EngineOutcome {
  text: string;
  usage: Usage;
  stopReason: "done" | "aborted" | "error";
  budgetExceeded: boolean;
  /** Proposals queued (deferred approvals) during this execution. */
  pendingProposalIds: string[];
  error?: string;
}

export interface AgentRuntimeDeps {
  engine: AgentEngine;
  audit: AuditSink;
  approvals: ApprovalBroker;
  killSwitch: KillSwitch;
  /** Root under which each agent gets a persistent working directory. */
  workdirRoot: string;
  /** Shared memory store, exposed to agents as memory-backed MCP tools (optional in tests). */
  memory?: MemoryStore;
  /** Loaded team plugins; an agent gets its own team's plugin tools (optional in tests). */
  plugins?: PluginRegistry;
  /** Per-node credential resolver; an agent gets only its own `.env` chain (optional in tests). */
  secrets?: SecretStore;
  clock?: Clock;
}

/**
 * The team-memory scope a node shares: a manager and its DIRECT reports resolve
 * to the same key (the manager's id). Note: only two levels share — a nested
 * sub-manager forms its own scope. Keep teams flat if they must share memory.
 */
export function managerScopeOf(node: RegistryNode): string {
  return node.childIds.length > 0 ? node.id : (node.parentId ?? node.id);
}

function sanitize(nodeId: string): string {
  return nodeId === "" ? "_root" : nodeId.replace(/\//g, "__");
}

/** Render a task contract into a prompt for the worker. */
function renderTaskPrompt(contract: TaskContract, privateDirName: string | null): string {
  const inputs = Object.entries(contract.inputs)
    .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  const fileNames = (contract.files ?? []).map((f) => path.basename(f));
  const workspaceSection = privateDirName
    ? [
        ``,
        `## Workspace (your working directory)`,
        `- \`shared/\` — shared with the whole team for THIS run. Read inputs here and`,
        `  write your outputs and any handoffs for the next agent here, with clear`,
        `  filenames. Earlier steps' files are already in \`shared/\`.`,
        `- \`${privateDirName}/\` — your private scratch for this run.`,
      ]
    : fileNames.length
      ? ["", `## Source files (in your working directory)`, ...fileNames.map((n) => `- ${n}`)]
      : [];
  return [
    `You have been assigned a task.`,
    ``,
    `## Goal`,
    contract.goal,
    ``,
    `## Inputs`,
    inputs || "(none)",
    ...workspaceSection,
    ``,
    `## Definition of done`,
    contract.definitionOfDone,
    ``,
    `Work toward the definition of done within your budget. When finished,`,
    `respond with a concise summary of what you did and any follow-ups.`,
    `If you cannot complete it, explain what is blocking you so it can be escalated.`,
  ].join("\n");
}

/**
 * Runs one agent (one registry node). Agents are event-driven: a runtime sits
 * idle (and spends nothing) until `runTask` / `chat` is called. Each run is
 * bounded by a budget and a kill-switch-backed abort signal, and every tool
 * call passes through the approval gate.
 */
export class AgentRuntime {
  state: AgentState = "idle";
  /** What this agent is doing right now (for the live console). */
  activity: AgentActivity = {};
  private readonly clock: Clock;
  private _node: RegistryNode;
  private pendingNode: RegistryNode | null = null;

  constructor(
    node: RegistryNode,
    private readonly deps: AgentRuntimeDeps,
    /** Default tier when the agent doesn't pin a model (manager=opus, worker=sonnet). */
    private readonly defaultTier: ModelTier = "sonnet",
  ) {
    this._node = node;
    this.clock = deps.clock ?? systemClock;
  }

  get node(): RegistryNode {
    return this._node;
  }

  /**
   * Swap in a new compiled config for this agent. If the agent is mid-run, the
   * current run finishes on its original config and the new one applies once it
   * goes idle — in-flight work is never disrupted by an edit.
   */
  updateNode(node: RegistryNode): void {
    if (this.state === "running" || this.state === "draining") {
      this.pendingNode = node;
    } else {
      this._node = node;
    }
  }

  get workdir(): string {
    return path.join(this.deps.workdirRoot, sanitize(this.node.id));
  }

  /**
   * Resolve the working directory for a task. With a per-run workspace, cwd is
   * the run root and the agent gets a shared `shared/` folder plus a private
   * `<nodeId>/` subfolder; otherwise it falls back to its persistent dir.
   */
  private async resolveWorkspace(
    contract: TaskContract,
  ): Promise<{ cwd: string; privateDirName: string | null }> {
    if (contract.workspaceRoot) {
      const privateDirName = sanitize(this.node.id);
      await fs.mkdir(path.join(contract.workspaceRoot, "shared"), { recursive: true });
      await fs.mkdir(path.join(contract.workspaceRoot, privateDirName), { recursive: true });
      return { cwd: contract.workspaceRoot, privateDirName };
    }
    await fs.mkdir(this.workdir, { recursive: true });
    return { cwd: this.workdir, privateDirName: null };
  }

  /**
   * Copy any source files attached to the contract into this agent's working
   * directory (under their basename), so the agent's file tools can read them.
   * Files are the host's; the agent only ever sees the staged copy.
   */
  private async stageFiles(contract: TaskContract, cwd: string): Promise<void> {
    if (!contract.files?.length) return;
    // In a workspace run, staged files belong in shared/ so every agent sees them.
    const destDir = contract.workspaceRoot ? path.join(cwd, "shared") : cwd;
    await fs.mkdir(destDir, { recursive: true });
    for (const src of contract.files) {
      const dest = path.join(destDir, path.basename(src));
      try {
        await fs.copyFile(src, dest);
        await this.deps.audit.append("task.file_staged", {
          nodeId: this.node.id,
          runId: contract.runId,
          data: { file: path.basename(src) },
        });
      } catch (err) {
        await this.deps.audit.append("task.file_stage_failed", {
          nodeId: this.node.id,
          runId: contract.runId,
          data: { file: src, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  /** Execute a single task contract to completion / budget / escalation. */
  async runTask(contract: TaskContract): Promise<TaskResult> {
    if (this.deps.killSwitch.isKilled(this.node.id)) {
      return this.abortedResult(contract, "agent is under an active kill");
    }
    if (this.state === "draining" || this.state === "killed") {
      return this.abortedResult(contract, `agent is ${this.state}`);
    }

    await this.deps.audit.append("task.started", {
      nodeId: this.node.id,
      runId: contract.runId,
      data: { contractId: contract.id, goal: contract.goal },
    });
    this.activity = { taskGoal: contract.goal, since: this.clock.iso() };

    const { cwd, privateDirName } = await this.resolveWorkspace(contract);
    await this.stageFiles(contract, cwd);
    const engine = await this.runEngine(renderTaskPrompt(contract, privateDirName), contract.budget, contract.runId, {
      // Workers may read their staged files; heavy tools only if explicitly granted.
      builtinTools: builtinToolsFor(this.node.tools, true),
      maxTurns: WORKER_MAX_TURNS,
      cwd,
    });
    const result: TaskResult = {
      contractId: contract.id,
      status: this.classify(engine.stopReason, engine.budgetExceeded, engine.pendingProposalIds.length),
      summary: engine.text || engine.error || "",
      artifacts: {},
      followUps: [],
      usage: engine.usage,
      ...(engine.pendingProposalIds.length ? { pendingProposalIds: engine.pendingProposalIds } : {}),
    };

    await this.deps.audit.append("task.finished", {
      nodeId: this.node.id,
      runId: contract.runId,
      // Carry the agent's own summary (its reasoning/decision) so the console shows
      // WHAT it concluded, not just which tools it called. Capped to keep the log lean.
      data: {
        contractId: contract.id,
        status: result.status,
        usage: result.usage,
        summary: result.summary.slice(0, 2000),
      },
    });
    return result;
  }

  /**
   * Run a raw prompt against this agent and return the text. Used by the
   * orchestrator's planner (the manager decomposing a playbook) and by owner
   * chat. Same budget, approval, kill-switch, and working-dir guarantees as a
   * task — only the framing differs.
   */
  async ask(
    prompt: string,
    opts: { budget?: Budget; runId?: string; allowRead?: boolean; maxTurns?: number } = {},
  ): Promise<EngineOutcome> {
    if (this.deps.killSwitch.isKilled(this.node.id) || this.state === "killed" || this.state === "draining") {
      return { text: "", usage: emptyUsage(), stopReason: "aborted", budgetExceeded: false, pendingProposalIds: [] };
    }
    // Planning is pure reasoning → no tools by default (allowRead=false). Chat
    // opts in to read-only so it can inspect files. Heavy tools only if granted.
    await fs.mkdir(this.workdir, { recursive: true });
    return this.runEngine(prompt, opts.budget ?? {}, opts.runId, {
      builtinTools: builtinToolsFor(this.node.tools, opts.allowRead ?? false),
      maxTurns: opts.maxTurns ?? PLANNING_MAX_TURNS,
      cwd: this.workdir,
    });
  }

  /**
   * Owner-facing chat with this specific agent. Same guarantees as a task; the
   * exchange is recorded to the audit trail so direct human↔agent conversations
   * are as auditable as orchestrated work.
   */
  async chat(message: string, opts: { budget?: Budget } = {}): Promise<string> {
    await this.deps.audit.append("chat.message", { nodeId: this.node.id, data: { message } });
    const outcome = await this.ask(message, { allowRead: true, maxTurns: CHAT_MAX_TURNS, ...(opts.budget ? { budget: opts.budget } : {}) });
    const reply = outcome.text || outcome.error || "(no reply)";
    await this.deps.audit.append("chat.reply", { nodeId: this.node.id, data: { reply } });
    return reply;
  }

  /** Shared engine mechanics: state, budget, kill switch, approval gate, timer. */
  private async runEngine(
    prompt: string,
    budget: Budget,
    runId: string | undefined,
    call: { builtinTools: string[]; maxTurns: number; cwd: string },
  ): Promise<EngineOutcome> {
    this.state = "running";
    const meter = new BudgetMeter(budget, this.clock);
    const controller = this.deps.killSwitch.register(this.node.id);
    const pendingProposalIds: string[] = [];

    let timer: NodeJS.Timeout | null = null;
    if (budget.seconds !== undefined) {
      timer = setTimeout(() => controller.abort(new Error("budget: seconds")), budget.seconds * 1000);
    }

    const model = resolveModel(this.node.spec.model, this.defaultTier);
    const managerNodeId = managerScopeOf(this.node);
    // Resolve this node's own credential scope (its `.env` chain). Tools fall back
    // to process.env for anything not set per-node.
    const nodeEnv = (await this.deps.secrets?.resolve(this.node.dir)) ?? {};
    const plugin = this.deps.plugins?.forNode(this.node.id);
    const pluginEnv: Record<string, string> = {};
    for (const k of plugin?.env ?? []) {
      const v = nodeEnv[k] ?? process.env[k];
      if (v !== undefined) pluginEnv[k] = v;
    }
    const request: EngineRequest = {
      systemPrompt: this.node.spec.systemPrompt,
      model,
      prompt,
      tools: this.node.tools,
      builtinTools: call.builtinTools,
      maxTurns: call.maxTurns,
      nodeEnv,
      cwd: call.cwd,
      ...(this.deps.memory
        ? {
            toolContext: {
              nodeId: this.node.id,
              managerNodeId,
              memory: this.deps.memory,
              ...(plugin?.tools ? { pluginTools: plugin.tools, pluginEnv } : {}),
            },
          }
        : {}),
      signal: controller.signal,
      decide: async (use) => {
        if (meter.exceeded()) return "deny";
        // Surface the in-flight tool to the live console before we gate it.
        this.activity = { ...this.activity, currentTool: use.name, waitingOnApproval: false };
        await this.deps.audit.append("tool.started", {
          nodeId: this.node.id,
          ...(runId !== undefined ? { runId } : {}),
          data: { tool: use.name },
        });
        const policy = policyForTool(this.node.tools, use.name);
        const result = await this.deps.approvals.decide({
          nodeId: this.node.id,
          toolName: use.name,
          input: use.input,
          policy,
          cwd: call.cwd,
          managerNodeId,
          ...(use.rationale !== undefined ? { rationale: use.rationale } : {}),
          ...(runId !== undefined ? { runId } : {}),
        });
        if (result.proposalId) {
          pendingProposalIds.push(result.proposalId);
          this.activity = { ...this.activity, waitingOnApproval: true };
        }
        return result.decision;
      },
      onUsage: (u) => {
        meter.recordUsage(u);
        if (meter.exceeded()) controller.abort(new Error("budget exhausted"));
      },
    };

    try {
      const engineResult = await this.deps.engine.run(request);
      meter.recordTurn();
      return {
        text: engineResult.text,
        // The engine's own total is authoritative (SDK total_cost_usd + cache
        // breakdown); the meter drove mid-run budget enforcement via onUsage.
        usage: engineResult.usage,
        stopReason: engineResult.stopReason,
        budgetExceeded: meter.exceeded() !== null,
        pendingProposalIds,
        ...(engineResult.error ? { error: engineResult.error } : {}),
      };
    } catch (err) {
      return {
        text: "",
        usage: meter.spent().usage,
        stopReason: "error",
        budgetExceeded: meter.exceeded() !== null,
        pendingProposalIds,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (timer) clearTimeout(timer);
      this.deps.killSwitch.release(this.node.id, controller);
      this.activity = {};
      const current = this.state as AgentState;
      this.state = current === "draining" || current === "killed" ? current : "idle";
      if (this.state === "idle" && this.pendingNode) {
        this._node = this.pendingNode;
        this.pendingNode = null;
      }
    }
  }

  private classify(
    stopReason: "done" | "aborted" | "error",
    budgetExceeded: boolean,
    pendingProposals: number,
  ): TaskStatus {
    if (budgetExceeded) return "budget_exhausted";
    if (stopReason === "aborted") return "aborted";
    if (stopReason === "error") return "failed";
    // Finished cleanly, but left consequential actions awaiting human approval.
    if (pendingProposals > 0) return "deferred";
    return "completed";
  }

  private abortedResult(contract: TaskContract, reason: string): TaskResult {
    return {
      contractId: contract.id,
      status: "aborted",
      summary: reason,
      artifacts: {},
      followUps: [],
      usage: emptyUsage(),
    };
  }

  /** Begin graceful drain — finish current run, accept no new work. */
  drain(): void {
    if (this.state === "killed") return;
    this.state = this.state === "running" ? "draining" : "idle";
  }

  markKilled(): void {
    this.state = "killed";
  }
}
