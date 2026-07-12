import type { Proposal } from "../domain/types.js";
import type { AuditSink } from "./audit.js";

export interface ActionContext {
  cwd: string;
  nodeId: string;
  runId?: string;
  /** Team-memory scope for team-scoped executor writes (e.g. watchlist). */
  managerNodeId?: string;
}

export interface ActionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type ActionHandler = (input: unknown, ctx: ActionContext) => Promise<ActionResult>;

/**
 * Performs approved proposed actions deterministically — no model call. The
 * other half of the async-gate model: agents *propose*, a human *approves*, and
 * this executor *does* the thing. Actions are registered by name (the bare tool
 * name an agent proposed, e.g. "deliver_to_client").
 */
export class ActionExecutor {
  private readonly handlers = new Map<string, ActionHandler>();

  constructor(private readonly audit: AuditSink) {}

  register(action: string, handler: ActionHandler): this {
    this.handlers.set(action, handler);
    return this;
  }

  has(action: string): boolean {
    return this.handlers.has(action);
  }

  /** Execute the action a proposal describes. Records the outcome to the audit log. */
  async execute(proposal: Proposal): Promise<ActionResult> {
    const handler = this.handlers.get(proposal.action);
    if (!handler) {
      const error = `no executor registered for action "${proposal.action}"`;
      await this.audit.append("proposal.execute_failed", {
        nodeId: proposal.nodeId,
        ...(proposal.runId !== undefined ? { runId: proposal.runId } : {}),
        data: { proposalId: proposal.id, action: proposal.action, error },
      });
      return { ok: false, error };
    }

    const ctx: ActionContext = {
      cwd: proposal.cwd,
      nodeId: proposal.nodeId,
      ...(proposal.runId !== undefined ? { runId: proposal.runId } : {}),
      ...(proposal.managerNodeId !== undefined ? { managerNodeId: proposal.managerNodeId } : {}),
    };
    let result: ActionResult;
    try {
      result = await handler(proposal.input, ctx);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    await this.audit.append(result.ok ? "proposal.executed" : "proposal.execute_failed", {
      nodeId: proposal.nodeId,
      ...(proposal.runId !== undefined ? { runId: proposal.runId } : {}),
      data: { proposalId: proposal.id, action: proposal.action, ...(result.error ? { error: result.error } : {}) },
    });
    return result;
  }
}
