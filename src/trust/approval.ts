import { EventEmitter } from "node:events";
import { newId, systemClock, type Clock } from "../domain/ids.js";
import type { ApprovalRequest, PermissionDecision } from "../domain/types.js";
import type { PermissionPolicy } from "../schemas/common.js";
import type { ToolsConfig } from "../schemas/tools.js";
import type { AuditSink } from "./audit.js";
import type { ProposalStore } from "./proposals.js";

/** Strip an MCP namespace (`mcp__server__tool`) to the bare tool name. */
function bareName(toolName: string): string {
  return toolName.includes("__") ? toolName.split("__").pop()! : toolName;
}

/**
 * Read-only built-in tools the runtime auto-exposes so agents can read their
 * staged files. They are safe and their results are needed inline, so they
 * default to `auto` — gating a read as a proposal both breaks the agent (it
 * never gets the content) and has no executor to perform it later. An author
 * can still override by listing one explicitly in tools.json.
 */
export const SAFE_AUTO_TOOLS = ["Read", "Glob", "Grep"];

/**
 * Resolve the effective permission policy for a tool from an agent's config.
 * Precedence: an explicit grant (author intent) → the safe read-only set
 * (`auto`) → the agent's `defaultPolicy`. MCP tools arrive namespaced
 * (`mcp__<server>__<tool>`); we match the bare name too so a grant for
 * `deliver_to_client` governs `mcp__office__deliver_to_client`.
 */
export function policyForTool(tools: ToolsConfig, toolName: string): PermissionPolicy {
  const bare = bareName(toolName);
  const grant = tools.tools.find((t) => t.name === toolName || t.name === bare);
  if (grant) return grant.policy;
  if (SAFE_AUTO_TOOLS.includes(bare)) return "auto";
  return tools.defaultPolicy;
}

export interface DecideRequest {
  nodeId: string;
  toolName: string;
  input: unknown;
  policy: PermissionPolicy;
  rationale?: string;
  runId?: string;
  /** Workspace root, recorded on a deferred proposal so the executor can act there. */
  cwd?: string;
  /** Team-memory scope, recorded so the executor can perform team-scoped writes. */
  managerNodeId?: string;
}

/** Decision plus, in deferred mode, the proposal that was queued for approval. */
export interface DecideResult {
  decision: PermissionDecision;
  proposalId?: string;
}

export type ApprovalMode = "sync" | "deferred";

/**
 * The human-in-the-loop gate. Every consequential tool call passes through here.
 *
 * Two modes:
 * - **deferred** (default): `ask` records a Proposal and immediately denies, so
 *   the agent never blocks — the run completes and a human approves later, out
 *   of band. This is what lets the platform run continuously.
 * - **sync**: `ask` blocks until a human resolves it (interactive CLI / tests).
 *
 * `auto`/`deny`/dry-run behave identically in both modes.
 */
export class ApprovalBroker extends EventEmitter {
  private readonly waiting = new Map<string, { req: ApprovalRequest; resolve: (d: PermissionDecision) => void }>();
  private readonly mode: ApprovalMode;

  constructor(
    private readonly audit: AuditSink,
    private readonly opts: { dryRun?: boolean; clock?: Clock; mode?: ApprovalMode; proposals?: ProposalStore } = {},
  ) {
    super();
    this.mode = opts.mode ?? "deferred";
  }

  private get clock(): Clock {
    return this.opts.clock ?? systemClock;
  }

  /** Sync-mode: currently-blocking approval requests. (Deferred uses ProposalStore.) */
  pending(): ApprovalRequest[] {
    return [...this.waiting.values()].map((w) => w.req);
  }

  async decide(req: DecideRequest): Promise<DecideResult> {
    if (this.opts.dryRun) {
      await this.audit.append("tool.dry_run", {
        nodeId: req.nodeId,
        runId: req.runId,
        data: { tool: req.toolName, input: req.input },
      });
      return { decision: "deny" };
    }

    if (req.policy === "auto") {
      await this.audit.append("tool.auto_allowed", {
        nodeId: req.nodeId,
        runId: req.runId,
        data: { tool: req.toolName },
      });
      return { decision: "allow" };
    }

    if (req.policy === "deny") {
      await this.audit.append("tool.denied_by_policy", {
        nodeId: req.nodeId,
        runId: req.runId,
        data: { tool: req.toolName },
      });
      return { decision: "deny" };
    }

    // policy === "ask"
    return this.mode === "deferred" ? this.defer(req) : this.block(req);
  }

  /** Deferred: queue a proposal and deny immediately (non-blocking). */
  private async defer(req: DecideRequest): Promise<DecideResult> {
    if (!this.opts.proposals) {
      throw new Error("deferred approval mode requires a ProposalStore");
    }
    const proposal = await this.opts.proposals.create({
      nodeId: req.nodeId,
      action: bareName(req.toolName),
      input: req.input,
      cwd: req.cwd ?? "",
      ...(req.managerNodeId !== undefined ? { managerNodeId: req.managerNodeId } : {}),
      ...(req.rationale !== undefined ? { rationale: req.rationale } : {}),
      ...(req.runId !== undefined ? { runId: req.runId } : {}),
    });
    await this.audit.append("proposal.created", {
      nodeId: req.nodeId,
      runId: req.runId,
      data: { proposalId: proposal.id, action: proposal.action, input: req.input },
    });
    return { decision: "deny", proposalId: proposal.id };
  }

  /** Sync: enqueue and block until a human resolves. */
  private async block(req: DecideRequest): Promise<DecideResult> {
    const request: ApprovalRequest = {
      id: newId("apr"),
      nodeId: req.nodeId,
      toolName: req.toolName,
      input: req.input,
      ...(req.rationale !== undefined ? { rationale: req.rationale } : {}),
      requestedAt: this.clock.iso(),
    };
    await this.audit.append("approval.requested", {
      nodeId: req.nodeId,
      runId: req.runId,
      data: { approvalId: request.id, tool: req.toolName, input: req.input },
    });
    const decision = await new Promise<PermissionDecision>((resolve) => {
      this.waiting.set(request.id, { req: request, resolve });
      this.emit("requested", request);
    });
    return { decision };
  }

  /** Resolve a pending *sync-mode* approval. No-op if unknown/already resolved. */
  async resolve(approvalId: string, decision: PermissionDecision): Promise<boolean> {
    const entry = this.waiting.get(approvalId);
    if (!entry) return false;
    this.waiting.delete(approvalId);
    await this.audit.append("approval.resolved", {
      nodeId: entry.req.nodeId,
      data: { approvalId, decision, tool: entry.req.toolName },
    });
    entry.resolve(decision);
    this.emit("resolved", approvalId, decision);
    return true;
  }
}
