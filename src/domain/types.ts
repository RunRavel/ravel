/**
 * Core runtime domain types shared across the engine, orchestrator, messaging,
 * and trust layers. These are deliberately serializable (plain data) so they
 * can be logged to the audit trail and replayed.
 */

import type { Budget } from "../schemas/common.js";

/** Token/cost accounting for a single model interaction or an aggregate. */
export interface Usage {
  /** Uncached input tokens (full price). */
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache (~0.1× input price). */
  cacheReadTokens: number;
  /** Tokens written to the prompt cache (~1.25× input price, 5-min TTL). */
  cacheCreationTokens: number;
  /** Estimated cost in USD, cache-aware. */
  usd: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    usd: a.usd + b.usd,
  };
}

/** Total tokens that hit the model this turn, cached or not. */
export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/**
 * A structured handoff from a manager to a worker. Dispatch is via contracts,
 * not free-form chat — this is the unit of orchestrated work. A task ends when
 * its definition-of-done is met, its budget is exhausted, or it escalates.
 */
export interface TaskContract {
  id: string;
  /** Node id of the agent expected to execute this task. */
  assigneeNodeId: string;
  /** Node id (or "owner") that issued the contract. */
  issuerNodeId: string;
  /** What to accomplish. */
  goal: string;
  /** Inputs/context the worker needs. */
  inputs: Record<string, unknown>;
  /** Checkable completion criteria. */
  definitionOfDone: string;
  /** Hard ceiling for this task. */
  budget: Budget;
  /** Optional ISO deadline. */
  deadline?: string;
  /** Process run this task belongs to, if any. */
  runId?: string;
  /**
   * Root of the shared per-run workspace. When set, this becomes the agent's
   * working directory for the task, giving it `shared/` (team-shared files for
   * the run) and a private `<nodeId>/` subfolder. Source files are staged into
   * `shared/` once by the orchestrator, so agents hand off artifacts by writing
   * to `shared/` rather than re-passing them through prompts.
   */
  workspaceRoot?: string;
  /**
   * Absolute host paths of source files to stage into the assignee's working
   * directory (legacy / standalone path; runs stage into the shared workspace).
   */
  files?: string[];
}

export type TaskStatus =
  | "completed"
  | "budget_exhausted"
  | "escalated"
  | "failed"
  | "aborted"
  /** Finished, but one or more consequential actions are awaiting human approval. */
  | "deferred";

/** The structured result a worker returns for a task contract. */
export interface TaskResult {
  contractId: string;
  status: TaskStatus;
  /** Worker's summary / answer. */
  summary: string;
  /** Artifacts produced (file paths, data), keyed by name. */
  artifacts: Record<string, unknown>;
  /** Follow-ups the worker surfaced (e.g. needs decision, blocked on X). */
  followUps: string[];
  usage: Usage;
  /** Proposals queued for human approval during this task (deferred actions). */
  pendingProposalIds?: string[];
}

/** Direction of an inter-agent message relative to the sender. */
export type MessageDirection = "down" | "up" | "sideways";

/** A message between agents, delivered via durable per-agent inboxes. */
export interface AgentMessage {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  direction: MessageDirection;
  /** "task" (a contract), "result", or "note" (free-form, rate-limited). */
  kind: "task" | "result" | "note";
  subject: string;
  body: string;
  /** Higher = more urgent; used for inbox prioritization into context. */
  priority: number;
  /** ISO timestamp set at enqueue. */
  enqueuedAt: string;
  /** Idempotency: redelivery carries the same id. */
  payload?: Record<string, unknown>;
}

/** Decision returned by the human-in-the-loop approval gate. */
export type PermissionDecision = "allow" | "deny";

/** A pending request for a human to approve a consequential action. */
export interface ApprovalRequest {
  id: string;
  nodeId: string;
  toolName: string;
  input: unknown;
  /** Why the agent wants to do this (model-provided rationale, if any). */
  rationale?: string;
  requestedAt: string;
}

export type ProposalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

/**
 * A consequential action an agent wanted to take, recorded for asynchronous
 * human approval rather than blocking the run. The agent proposes; the run
 * completes; a human approves on their own schedule; an executor then performs
 * the action deterministically (no second model call). This is what makes the
 * platform able to run continuously without a human in the critical path.
 */
export interface Proposal {
  id: string;
  runId?: string;
  nodeId: string;
  /** Team-memory scope key (manager + direct reports share it). For executor team writes. */
  managerNodeId?: string;
  /** Bare action/tool name (e.g. "deliver_to_client"). */
  action: string;
  input: unknown;
  /** Model-provided rationale, if any. */
  rationale?: string;
  /** Workspace root the executor should act in (matches the agent's cwd). */
  cwd: string;
  createdAt: string;
  status: ProposalStatus;
  decidedAt?: string;
  executedAt?: string;
  /** Executor result on success. */
  result?: unknown;
  error?: string;
}

