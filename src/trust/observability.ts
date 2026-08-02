import { addUsage, emptyUsage, type Usage } from "../domain/types.js";
import type { AuditSink, AuditEvent } from "./audit.js";
import type { ProposalStore } from "./proposals.js";
import type { Lifecycle } from "../runtime/lifecycle.js";
import type { AgentState, AgentActivity } from "../runtime/agent.js";

export interface AgentMetric {
  nodeId: string;
  name: string;
  role: string;
  state: AgentState;
  tasksRun: number;
  /** Tasks that ended failed/aborted/budget_exhausted (subset of tasksRun). */
  tasksFailed: number;
  usage: Usage;
  /** Task latency over runs with a paired start/finish: median and mean, ms. Null until there's data. */
  p50Ms: number | null;
  meanMs: number | null;
  /** What the agent is doing right now (empty when idle). */
  activity: AgentActivity;
}

export interface ProcessRunMetric {
  runId: string;
  process: string;
  status: string;
  turns: number;
  usage: Usage;
}

export interface DashboardSnapshot {
  totalUsage: Usage;
  agents: AgentMetric[];
  processRuns: ProcessRunMetric[];
  /** Deferred actions awaiting an async human decision. */
  pendingProposals: number;
  deadLetters: number;
  eventCount: number;
}

/**
 * Derives a live cost/trace view from the append-only audit trail plus the
 * current lifecycle/approval state. Observability is first-class: the owner can
 * always see what each agent has spent, what's running, and what's waiting on
 * them — no separate instrumentation, just a read over the audit log.
 */
export class Observer {
  constructor(
    private readonly audit: AuditSink,
    private readonly lifecycle: Lifecycle,
    private readonly proposals: ProposalStore,
    private readonly deadLetterCount: () => number = () => 0,
  ) {}

  snapshot(): DashboardSnapshot {
    const events = this.audit.all();
    const perNodeUsage = new Map<string, Usage>();
    const perNodeTasks = new Map<string, number>();
    const perNodeFailed = new Map<string, number>();
    // task.started timestamps by contractId, so a later task.finished can be
    // paired with its start to compute duration.
    const startAt = new Map<string, number>();
    const perNodeDurations = new Map<string, number[]>();
    const FAILED_STATUSES = new Set(["failed", "aborted", "budget_exhausted"]);
    const processRuns: ProcessRunMetric[] = [];
    let totalUsage = emptyUsage();

    for (const e of events) {
      if (e.type === "task.started") {
        const id = e.data["contractId"];
        if (typeof id === "string") startAt.set(id, Date.parse(e.at));
      } else if (e.type === "process.turn" && e.nodeId !== undefined) {
        // The owner's planning turn — attribute its cost to the owner node, same
        // as a dispatched task's, but WITHOUT counting it as a task (no
        // tasksRun/tasksFailed/latency impact: it isn't a dispatched contract).
        const u = (e.data["usage"] as Usage | undefined) ?? emptyUsage();
        perNodeUsage.set(e.nodeId, addUsage(perNodeUsage.get(e.nodeId) ?? emptyUsage(), u));
        totalUsage = addUsage(totalUsage, u);
      } else if (e.type === "task.finished" && e.nodeId !== undefined) {
        const u = (e.data["usage"] as Usage | undefined) ?? emptyUsage();
        perNodeUsage.set(e.nodeId, addUsage(perNodeUsage.get(e.nodeId) ?? emptyUsage(), u));
        perNodeTasks.set(e.nodeId, (perNodeTasks.get(e.nodeId) ?? 0) + 1);
        totalUsage = addUsage(totalUsage, u);
        if (FAILED_STATUSES.has(String(e.data["status"] ?? ""))) {
          perNodeFailed.set(e.nodeId, (perNodeFailed.get(e.nodeId) ?? 0) + 1);
        }
        const id = e.data["contractId"];
        const started = typeof id === "string" ? startAt.get(id) : undefined;
        if (started !== undefined) {
          const ms = Date.parse(e.at) - started;
          if (ms >= 0) {
            const arr = perNodeDurations.get(e.nodeId) ?? [];
            arr.push(ms);
            perNodeDurations.set(e.nodeId, arr);
          }
        }
      } else if (e.type === "process.finished") {
        processRuns.push(this.toProcessMetric(e));
      }
    }

    const agents: AgentMetric[] = this.lifecycle.all().map((rt) => {
      const durations = perNodeDurations.get(rt.node.id) ?? [];
      return {
        nodeId: rt.node.id,
        name: rt.node.spec.name,
        role: rt.node.spec.role ?? rt.node.spec.name,
        state: rt.state,
        tasksRun: perNodeTasks.get(rt.node.id) ?? 0,
        tasksFailed: perNodeFailed.get(rt.node.id) ?? 0,
        usage: perNodeUsage.get(rt.node.id) ?? emptyUsage(),
        p50Ms: percentile(durations, 50),
        meanMs: mean(durations),
        activity: rt.activity,
      };
    });

    return {
      totalUsage,
      agents,
      processRuns,
      pendingProposals: this.proposals.pending().length,
      deadLetters: this.deadLetterCount(),
      eventCount: events.length,
    };
  }

  private toProcessMetric(e: AuditEvent): ProcessRunMetric {
    return {
      runId: e.runId ?? "",
      process: String(e.data["process"] ?? ""),
      status: String(e.data["status"] ?? ""),
      turns: Number(e.data["turns"] ?? 0),
      usage: (e.data["usage"] as Usage | undefined) ?? emptyUsage(),
    };
  }
}

/** Nearest-rank percentile of `values` (ms), or null if empty. `p` in [0,100]. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // clamp rank to [1, length] so p=0 doesn't index -1 and p=100 stays in bounds.
  const rank = Math.min(Math.max(1, Math.ceil((p / 100) * sorted.length)), sorted.length);
  return sorted[rank - 1]!;
}

/** Rounded arithmetic mean of `values` (ms), or null if empty. */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}
