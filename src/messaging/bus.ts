import path from "node:path";
import type { RegistryNode, RegistrySnapshot } from "../control-plane/registry.js";
import type { AgentMessage, MessageDirection } from "../domain/types.js";
import { newId, systemClock, type Clock } from "../domain/ids.js";
import type { AuditSink } from "../trust/audit.js";
import { Inbox, InboxFullError } from "./inbox.js";

export interface MessageBusDeps {
  audit: AuditSink;
  /** Directory for durable inbox files; omit for in-memory inboxes. */
  messagesDir?: string;
  clock?: Clock;
  inboxCap?: number;
}

export interface DeadLetter {
  message: AgentMessage;
  reason: string;
}

type Relation = MessageDirection | "invalid";

/**
 * Routes messages between agents through durable per-agent inboxes.
 *
 * Communication is constrained to the org topology: an agent may message DOWN
 * (a direct report), UP (its manager), or SIDEWAYS (a peer under the same
 * manager). Anything else is dead-lettered. When a recipient's inbox is full,
 * the bus escalates an overflow note to that agent's manager rather than
 * silently dropping work — backpressure that surfaces, not hides.
 */
export class MessageBus {
  private nodes: ReadonlyMap<string, RegistryNode> = new Map();
  private readonly inboxes = new Map<string, Inbox>();
  readonly deadLetters: DeadLetter[] = [];
  private readonly clock: Clock;

  constructor(private readonly deps: MessageBusDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Update the topology the bus validates against (called on each new snapshot). */
  updateTopology(snapshot: RegistrySnapshot): void {
    this.nodes = snapshot.nodes;
  }

  inbox(nodeId: string): Inbox {
    let box = this.inboxes.get(nodeId);
    if (!box) {
      box = new Inbox(nodeId, {
        ...(this.deps.inboxCap !== undefined ? { cap: this.deps.inboxCap } : {}),
        ...(this.deps.messagesDir
          ? { filePath: path.join(this.deps.messagesDir, `${nodeId === "" ? "_root" : nodeId.replace(/\//g, "__")}.json`) }
          : {}),
      });
      this.inboxes.set(nodeId, box);
    }
    return box;
  }

  /** Build a message with id/timestamp filled in. */
  compose(fields: Omit<AgentMessage, "id" | "enqueuedAt">): AgentMessage {
    return { ...fields, id: newId("msg"), enqueuedAt: this.clock.iso() };
  }

  private relation(from: string, to: string): Relation {
    const fromNode = this.nodes.get(from);
    const toNode = this.nodes.get(to);
    if (!fromNode || !toNode) return "invalid";
    if (fromNode.parentId === to) return "up";
    if (toNode.parentId === from) return "down";
    if (fromNode.parentId !== null && fromNode.parentId === toNode.parentId) return "sideways";
    return "invalid";
  }

  private async deadLetter(message: AgentMessage, reason: string): Promise<void> {
    this.deadLetters.push({ message, reason });
    await this.deps.audit.append("message.deadletter", {
      nodeId: message.toNodeId,
      data: { messageId: message.id, from: message.fromNodeId, reason },
    });
  }

  /**
   * Deliver a message. Returns the outcome so callers can react. Idempotent on
   * message id (duplicate redelivery is a successful no-op).
   */
  async send(message: AgentMessage): Promise<"delivered" | "duplicate" | "deadletter" | "escalated"> {
    const relation = this.relation(message.fromNodeId, message.toNodeId);
    if (relation === "invalid") {
      await this.deadLetter(message, "invalid_route");
      return "deadletter";
    }
    if (relation !== message.direction) {
      await this.deadLetter(message, `direction_mismatch (declared ${message.direction}, actual ${relation})`);
      return "deadletter";
    }

    try {
      const inserted = await this.inbox(message.toNodeId).enqueue(message);
      if (!inserted) return "duplicate";
      await this.deps.audit.append("message.delivered", {
        nodeId: message.toNodeId,
        data: { messageId: message.id, from: message.fromNodeId, kind: message.kind },
      });
      return "delivered";
    } catch (err) {
      if (!(err instanceof InboxFullError)) throw err;
      return this.escalateOverflow(message);
    }
  }

  /** On a full inbox, send an overflow note up to the recipient's manager. */
  private async escalateOverflow(message: AgentMessage): Promise<"escalated" | "deadletter"> {
    const recipient = this.nodes.get(message.toNodeId);
    const managerId = recipient?.parentId ?? null;
    if (managerId === null) {
      await this.deadLetter(message, "inbox_full_no_manager");
      return "deadletter";
    }
    const note = this.compose({
      fromNodeId: message.toNodeId,
      toNodeId: managerId,
      direction: "up",
      kind: "note",
      subject: `Inbox overflow for ${message.toNodeId}`,
      body: `Inbox is full; a message from ${message.fromNodeId} ("${message.subject}") could not be delivered and needs attention.`,
      priority: 10,
    });
    await this.deps.audit.append("message.backpressure", {
      nodeId: message.toNodeId,
      data: { droppedMessageId: message.id, escalatedTo: managerId },
    });
    // Best-effort escalation; if the manager is also full, dead-letter the note.
    try {
      await this.inbox(managerId).enqueue(note);
    } catch {
      await this.deadLetter(note, "manager_inbox_full");
    }
    await this.deadLetter(message, "inbox_full_escalated");
    return "escalated";
  }
}
