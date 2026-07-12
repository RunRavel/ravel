import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "../domain/types.js";

/**
 * A durable, per-agent message queue. Delivery is at-least-once with
 * idempotency by message id (a redelivered message with a known id is ignored).
 * Messages are ordered by priority (desc) then enqueue time (asc) so the most
 * urgent surface first when injected into the agent's context.
 *
 * Persistence is a simple rewrite-on-change of the pending set — queues are
 * small (an agent that accumulates hundreds of messages is a design smell the
 * backpressure cap is meant to catch).
 */
export class Inbox {
  private pending: AgentMessage[] = [];
  private readonly seen = new Set<string>();

  constructor(
    readonly nodeId: string,
    private readonly opts: { cap?: number; filePath?: string } = {},
  ) {}

  get cap(): number {
    return this.opts.cap ?? 100;
  }

  size(): number {
    return this.pending.length;
  }

  isFull(): boolean {
    return this.pending.length >= this.cap;
  }

  /** Load persisted messages from disk, if a file path was configured. */
  async load(): Promise<void> {
    if (!this.opts.filePath) return;
    try {
      const raw = await fs.readFile(this.opts.filePath, "utf8");
      const parsed = JSON.parse(raw) as AgentMessage[];
      this.pending = parsed;
      for (const m of parsed) this.seen.add(m.id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * Enqueue a message. Returns false if it was a duplicate (already seen) — the
   * caller can treat that as a successful no-op (idempotent redelivery).
   * Throws if the inbox is full so the bus can apply backpressure.
   */
  async enqueue(message: AgentMessage): Promise<boolean> {
    if (this.seen.has(message.id)) return false;
    if (this.isFull()) throw new InboxFullError(this.nodeId);
    this.seen.add(message.id);
    this.pending.push(message);
    this.sort();
    await this.persist();
    return true;
  }

  /** Remove and return up to `n` highest-priority messages. */
  async dequeue(n = 1): Promise<AgentMessage[]> {
    const taken = this.pending.splice(0, n);
    if (taken.length) await this.persist();
    return taken;
  }

  /** Non-destructive view, highest priority first. */
  peek(): readonly AgentMessage[] {
    return this.pending;
  }

  private sort(): void {
    this.pending.sort((a, b) => b.priority - a.priority || a.enqueuedAt.localeCompare(b.enqueuedAt));
  }

  private async persist(): Promise<void> {
    if (!this.opts.filePath) return;
    await fs.mkdir(path.dirname(this.opts.filePath), { recursive: true });
    await fs.writeFile(this.opts.filePath, JSON.stringify(this.pending), "utf8");
  }
}

export class InboxFullError extends Error {
  constructor(readonly nodeId: string) {
    super(`inbox for ${nodeId} is full`);
    this.name = "InboxFullError";
  }
}

/**
 * Turn a set of inbox messages into a bounded, prioritized context block for an
 * agent's prompt. Messages are NEVER raw-replayed wholesale — they are ranked
 * by priority and truncated to `maxChars`, with an explicit note about any that
 * were omitted, so a flooded inbox can't blow the context window.
 */
export function summarizeInbox(messages: readonly AgentMessage[], maxChars = 4000): string {
  if (messages.length === 0) return "(no new messages)";
  const sorted = [...messages].sort(
    (a, b) => b.priority - a.priority || a.enqueuedAt.localeCompare(b.enqueuedAt),
  );
  const lines: string[] = [];
  let used = 0;
  let included = 0;
  for (const m of sorted) {
    const body = m.body.length > 280 ? `${m.body.slice(0, 277)}...` : m.body;
    const line = `- [${m.kind} ${m.direction} from ${m.fromNodeId}] ${m.subject}: ${body}`;
    if (used + line.length > maxChars && included > 0) break;
    lines.push(line);
    used += line.length + 1;
    included += 1;
  }
  const omitted = sorted.length - included;
  if (omitted > 0) lines.push(`- (+${omitted} more lower-priority message(s) omitted)`);
  return lines.join("\n");
}
