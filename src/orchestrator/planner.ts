import { z } from "zod";
import type { Budget } from "../schemas/common.js";
import type { ProcessSpec } from "../schemas/process.js";
import { emptyUsage, type TaskResult, type Usage } from "../domain/types.js";
import type { AgentRuntime } from "../runtime/agent.js";

/** A worker the owner may dispatch to (a descendant in the org tree). */
export interface RosterEntry {
  nodeId: string;
  role: string;
  name: string;
}

export interface PlanContext {
  process: ProcessSpec;
  ownerNodeId: string;
  roster: RosterEntry[];
  /** Results of tasks dispatched so far in this run (fed back for re-planning). */
  priorResults: TaskResult[];
  budgetRemaining: Budget;
  runId: string;
  /** Owner-supplied inputs for this run (e.g. prospect name, target languages). */
  runInputs?: Record<string, unknown>;
  /** Basenames of source files staged for this run, available to workers. */
  runFileNames?: string[];
}

/** One task the owner wants to dispatch. */
export interface PlannedTask {
  assigneeRole: string;
  goal: string;
  definitionOfDone: string;
  inputs?: Record<string, unknown>;
  /**
   * Optional per-task budget ceiling. Use it for fan-out (one task per item) so
   * each task gets its own bounded slice rather than the whole remaining budget.
   * Clamped to what's left of the process budget at dispatch.
   */
  budget?: Budget;
}

/**
 * The owner's decision for this orchestration turn: either dispatch more tasks,
 * or declare the process done with a final summary.
 */
export interface Plan {
  done: boolean;
  summary?: string;
  tasks: PlannedTask[];
  usage: Usage;
}

/**
 * Decomposition is delegated to the owning manager agent — the orchestrator
 * only runs the deterministic loop. Production uses `EnginePlanner` (the
 * manager LLM emits a structured plan); tests inject a deterministic fake.
 */
export interface Planner {
  plan(ctx: PlanContext): Promise<Plan>;
}

const PlanSchema = z.object({
  done: z.boolean(),
  summary: z.string().optional(),
  tasks: z
    .array(
      z.object({
        assigneeRole: z.string().min(1),
        goal: z.string().min(1),
        definitionOfDone: z.string().min(1),
        inputs: z.record(z.unknown()).optional(),
        budget: z
          .object({
            tokens: z.number().optional(),
            usd: z.number().optional(),
            seconds: z.number().optional(),
            turns: z.number().optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

/** Pull the first balanced top-level JSON object out of a model's text reply. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function renderPlanPrompt(ctx: PlanContext): string {
  const roster = ctx.roster.map((r) => `- role "${r.role}" (${r.name})`).join("\n") || "(no direct reports)";
  const prior =
    ctx.priorResults.length === 0
      ? "(none yet — this is the first turn)"
      : ctx.priorResults
          .map((r, i) => `${i + 1}. [${r.status}] ${r.summary}`)
          .join("\n");
  const inputs =
    ctx.runInputs && Object.keys(ctx.runInputs).length
      ? Object.entries(ctx.runInputs)
          .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join("\n")
      : "(none)";
  const files = ctx.runFileNames?.length
    ? ctx.runFileNames.map((n) => `- ${n}`).join("\n")
    : "(none)";
  return [
    `You are orchestrating the process "${ctx.process.name}".`,
    ``,
    `## Playbook`,
    ctx.process.playbook,
    ``,
    `## Run inputs`,
    inputs,
    ``,
    `## Source files (staged into each worker's working directory when dispatched)`,
    files,
    ``,
    `## Definition of done`,
    ctx.process.definitionOfDone,
    ``,
    `## Your team (you may dispatch tasks to these roles only)`,
    roster,
    ``,
    `## Results so far`,
    prior,
    ``,
    `Decide the next step. Respond with ONLY a JSON object of the form:`,
    `{"done": boolean, "summary": string, "tasks": [{"assigneeRole": string, "goal": string, "definitionOfDone": string, "inputs": {}, "budget": {"usd": number, "turns": number}}]}`,
    `Set "done": true with a "summary" when the definition of done is met or cannot be advanced.`,
    `Otherwise set "done": false and list the task(s) to dispatch this turn.`,
    `When you fan out over many items (e.g. one investigation per candidate),`,
    `dispatch ONE task per item and give each a small per-task "budget" (e.g.`,
    `{"usd": 0.5, "turns": 6}) so a long item can't drain the whole process budget.`,
    `Omit "budget" for a single task that may use the remaining budget.`,
    `A result marked [deferred] means the worker finished but a consequential action`,
    `(e.g. sending or delivering) is queued for human approval — that work is DONE`,
    `from your side. Do NOT re-dispatch a deferred task; treat its step as complete`,
    `and mark the process "done" once the remaining steps are covered.`,
  ].join("\n");
}

/**
 * Planner backed by the owning agent's model. Asks the manager to emit a
 * structured plan; if the reply can't be parsed as a plan, treats the reply as
 * a final summary (fail safe — never loops on malformed output).
 */
export class EnginePlanner implements Planner {
  constructor(private readonly resolveRuntime: (nodeId: string) => AgentRuntime | undefined) {}

  async plan(ctx: PlanContext): Promise<Plan> {
    const owner = this.resolveRuntime(ctx.ownerNodeId);
    if (!owner) {
      return { done: true, summary: `owner ${ctx.ownerNodeId} has no runtime`, tasks: [], usage: emptyUsage() };
    }
    let outcome = await owner.ask(renderPlanPrompt(ctx), {
      budget: ctx.budgetRemaining,
      runId: ctx.runId,
    });
    let parsed = PlanSchema.safeParse(extractJsonObject(outcome.text));
    if (!parsed.success) {
      // No parseable plan. The planner may have spent its turn budget on tool
      // calls and never emitted the JSON. Retry once, demanding JSON and no tools
      // — distinguishes "ran out of turns inspecting" from "genuinely done".
      outcome = await owner.ask(
        renderPlanPrompt(ctx) +
          `\n\nIMPORTANT: Respond with ONLY the JSON plan object — no prose, and do NOT call any tools. ` +
          `If there is nothing left to dispatch, return {"done": true, "summary": "..."}.`,
        { budget: ctx.budgetRemaining, runId: ctx.runId },
      );
      parsed = PlanSchema.safeParse(extractJsonObject(outcome.text));
    }
    if (!parsed.success) {
      // Still no plan — terminate, but make the reason VISIBLE rather than
      // reporting a clean "completed" that silently did nothing.
      return {
        done: true,
        summary: `Planner produced no structured plan (stopReason=${outcome.stopReason}${
          outcome.budgetExceeded ? ", budget exhausted" : ""
        }). No tasks dispatched. Raw reply: ${(outcome.text || "(empty)").slice(0, 200)}`,
        tasks: [],
        usage: outcome.usage,
      };
    }
    return {
      done: parsed.data.done,
      ...(parsed.data.summary !== undefined ? { summary: parsed.data.summary } : {}),
      tasks: parsed.data.tasks,
      usage: outcome.usage,
    };
  }
}
