import { promises as fs } from "node:fs";
import path, { basename } from "node:path";
import type { RegistryProcess, RegistrySnapshot } from "../control-plane/registry.js";
import type { Budget } from "../schemas/common.js";
import { BudgetMeter } from "../trust/budget.js";
import type { AuditSink } from "../trust/audit.js";
import { newId, systemClock, type Clock } from "../domain/ids.js";
import {
  addUsage,
  emptyUsage,
  type TaskContract,
  type TaskResult,
  type Usage,
} from "../domain/types.js";
import type { Lifecycle } from "../runtime/lifecycle.js";
import type { Planner, PlanContext, RosterEntry } from "./planner.js";

/** Hard ceiling on orchestration turns, independent of budget, to bound any loop. */
const ABSOLUTE_MAX_TURNS = 12;

/**
 * Field-wise minimum of a requested per-task budget and what's left of the
 * process budget — a task can ask for less but never more than remains.
 */
export function clampBudget(requested: Budget | undefined, remaining: Budget): Budget {
  if (!requested) return remaining;
  const out: Budget = { ...remaining };
  for (const k of ["tokens", "usd", "seconds", "turns"] as const) {
    const req = requested[k];
    const rem = remaining[k];
    if (req !== undefined) out[k] = rem !== undefined ? Math.min(req, rem) : req;
  }
  return out;
}

export type ProcessRunStatus = "completed" | "budget_exhausted" | "failed";

export interface ProcessRunResult {
  runId: string;
  processName: string;
  status: ProcessRunStatus;
  summary: string;
  /** Every task result produced, in dispatch order. */
  results: TaskResult[];
  usage: Usage;
  turns: number;
  /** The run's shared workspace dir, where deliverables/handoffs live (if any). */
  workspaceDir?: string;
}

export interface OrchestratorDeps {
  lifecycle: Lifecycle;
  planner: Planner;
  audit: AuditSink;
  /** Parent dir for per-run workspaces. When set, runs get a shared workspace. */
  workspaceRoot?: string;
  clock?: Clock;
}

/**
 * Runs a process to completion via the orchestrated task-contract model:
 *
 *   plan (owner decomposes) → dispatch contracts to workers → collect results
 *   → re-plan with results → … until done / budget / turn cap.
 *
 * This is the deterministic control loop. There is no free-form agent chatter:
 * every handoff is a structured TaskContract and every return is a TaskResult.
 * The process budget bounds total spend and turns so a run always terminates.
 */
export class Orchestrator {
  private readonly clock: Clock;
  constructor(private readonly deps: OrchestratorDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Resolve the workers an owner may dispatch to: its descendants in the tree. */
  private rosterFor(ownerId: string, snapshot: RegistrySnapshot): RosterEntry[] {
    const prefix = ownerId === "" ? "" : `${ownerId}/`;
    const roster: RosterEntry[] = [];
    for (const node of snapshot.nodes.values()) {
      if (node.id === ownerId) continue;
      const inSubtree = ownerId === "" ? node.id !== "" : node.id.startsWith(prefix);
      if (inSubtree && this.deps.lifecycle.get(node.id)) {
        roster.push({ nodeId: node.id, role: node.spec.role ?? node.spec.name, name: node.spec.name });
      }
    }
    return roster;
  }

  private resolveAssignee(role: string, roster: RosterEntry[]): RosterEntry | undefined {
    const needle = role.trim().toLowerCase();
    return roster.find(
      (r) => r.role.toLowerCase() === needle || r.name.toLowerCase() === needle || r.nodeId.toLowerCase() === needle,
    );
  }

  async runProcess(
    proc: RegistryProcess,
    snapshot: RegistrySnapshot,
    run: { inputs?: Record<string, unknown>; files?: string[]; runId?: string } = {},
  ): Promise<ProcessRunResult> {
    const runId = run.runId ?? newId("run");
    const processName = proc.spec.name;
    const budget: Budget = proc.spec.budget ?? { turns: ABSOLUTE_MAX_TURNS };
    const meter = new BudgetMeter(budget, this.clock);
    const results: TaskResult[] = [];
    let usage: Usage = emptyUsage();

    await this.deps.audit.append("process.started", {
      nodeId: proc.ownerNodeId,
      runId,
      data: { process: processName, ...(run.inputs ? { inputs: run.inputs } : {}) },
    });

    const owner = this.deps.lifecycle.get(proc.ownerNodeId);
    if (!owner) {
      return this.finalize(runId, processName, "failed", `owner ${proc.ownerNodeId} has no runtime`, results, usage, 0);
    }

    // Provision the per-run shared workspace and stage input files into shared/
    // once, so every dispatched agent reads inputs and hands off artifacts there.
    let workspaceRoot: string | undefined;
    let sharedDir: string | undefined;
    if (this.deps.workspaceRoot) {
      workspaceRoot = path.join(this.deps.workspaceRoot, runId);
      sharedDir = path.join(workspaceRoot, "shared");
      await fs.mkdir(sharedDir, { recursive: true });
      for (const src of run.files ?? []) {
        try {
          await fs.copyFile(src, path.join(sharedDir, basename(src)));
          await this.deps.audit.append("run.file_staged", { runId, data: { file: basename(src) } });
        } catch (err) {
          await this.deps.audit.append("run.file_stage_failed", {
            runId,
            data: { file: src, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }

    const roster = this.rosterFor(proc.ownerNodeId, snapshot);
    let status: ProcessRunStatus = "completed";
    let summary = "";
    let turns = 0;

    while (turns < ABSOLUTE_MAX_TURNS) {
      if (meter.exceeded()) {
        status = "budget_exhausted";
        summary = `Process budget exhausted (${meter.exceeded()}).`;
        break;
      }
      meter.recordTurn();
      turns += 1;

      const ctx: PlanContext = {
        process: proc.spec,
        ownerNodeId: proc.ownerNodeId,
        roster,
        priorResults: results,
        budgetRemaining: meter.remaining(),
        runId,
        ...(run.inputs ? { runInputs: run.inputs } : {}),
        ...(run.files?.length ? { runFileNames: run.files.map((f) => basename(f)) } : {}),
      };
      const plan = await this.deps.planner.plan(ctx);
      meter.recordUsage(plan.usage);
      usage = addUsage(usage, plan.usage);

      await this.deps.audit.append("process.turn", {
        nodeId: proc.ownerNodeId,
        runId,
        data: {
          turn: turns,
          done: plan.done,
          taskCount: plan.tasks.length,
          assignees: plan.tasks.map((t) => t.assigneeRole),
        },
      });

      if (plan.done) {
        summary = plan.summary ?? "Process completed.";
        status = "completed";
        break;
      }

      if (plan.tasks.length === 0) {
        // No tasks and not done — nothing to advance; stop rather than spin.
        summary = plan.summary ?? "Owner produced no tasks and did not mark the process done.";
        status = "failed";
        break;
      }

      for (const task of plan.tasks) {
        const assignee = this.resolveAssignee(task.assigneeRole, roster);
        if (!assignee) {
          const failed: TaskResult = {
            contractId: newId("task"),
            status: "failed",
            summary: `No agent for role "${task.assigneeRole}"`,
            artifacts: {},
            followUps: [],
            usage: emptyUsage(),
          };
          results.push(failed);
          await this.deps.audit.append("task.unrouted", {
            nodeId: proc.ownerNodeId,
            runId,
            data: { role: task.assigneeRole },
          });
          continue;
        }

        const worker = this.deps.lifecycle.get(assignee.nodeId)!;
        const contract: TaskContract = {
          id: newId("task"),
          assigneeNodeId: assignee.nodeId,
          issuerNodeId: proc.ownerNodeId,
          goal: task.goal,
          // Run-level inputs are available to every task; the planned task's own
          // inputs take precedence on key collisions.
          inputs: { ...(run.inputs ?? {}), ...(task.inputs ?? {}) },
          definitionOfDone: task.definitionOfDone,
          // A task's own budget (used for fan-out) is clamped to what's left; with
          // no per-task budget it gets the whole remaining process budget.
          budget: clampBudget(task.budget, meter.remaining()),
          runId,
          // All run agents share one workspace; inputs are already staged in shared/.
          ...(workspaceRoot ? { workspaceRoot } : {}),
        };
        const result = await worker.runTask(contract);
        results.push(result);
        meter.recordUsage(result.usage);
        usage = addUsage(usage, result.usage);
      }
    }

    if (turns >= ABSOLUTE_MAX_TURNS && status === "completed" && summary === "") {
      status = "budget_exhausted";
      summary = `Reached the orchestration turn cap (${ABSOLUTE_MAX_TURNS}).`;
    }

    return this.finalize(runId, processName, status, summary, results, usage, turns, sharedDir);
  }

  private async finalize(
    runId: string,
    processName: string,
    status: ProcessRunStatus,
    summary: string,
    results: TaskResult[],
    usage: Usage,
    turns: number,
    workspaceDir?: string,
  ): Promise<ProcessRunResult> {
    await this.deps.audit.append("process.finished", {
      runId,
      data: { process: processName, status, turns, usage },
    });
    return {
      runId,
      processName,
      status,
      summary,
      results,
      usage,
      turns,
      ...(workspaceDir ? { workspaceDir } : {}),
    };
  }
}
