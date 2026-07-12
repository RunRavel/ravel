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
  usage: Usage;
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
    const processRuns: ProcessRunMetric[] = [];
    let totalUsage = emptyUsage();

    for (const e of events) {
      if (e.type === "task.finished" && e.nodeId !== undefined) {
        const u = (e.data["usage"] as Usage | undefined) ?? emptyUsage();
        perNodeUsage.set(e.nodeId, addUsage(perNodeUsage.get(e.nodeId) ?? emptyUsage(), u));
        perNodeTasks.set(e.nodeId, (perNodeTasks.get(e.nodeId) ?? 0) + 1);
        totalUsage = addUsage(totalUsage, u);
      } else if (e.type === "process.finished") {
        processRuns.push(this.toProcessMetric(e));
      }
    }

    const agents: AgentMetric[] = this.lifecycle.all().map((rt) => ({
      nodeId: rt.node.id,
      name: rt.node.spec.name,
      role: rt.node.spec.role ?? rt.node.spec.name,
      state: rt.state,
      tasksRun: perNodeTasks.get(rt.node.id) ?? 0,
      usage: perNodeUsage.get(rt.node.id) ?? emptyUsage(),
      activity: rt.activity,
    }));

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
