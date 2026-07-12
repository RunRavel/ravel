import { EventEmitter } from "node:events";
import type { AuditSink, AuditEvent } from "./audit.js";

/**
 * Wraps an AuditSink and re-emits each appended event as a structured object on
 * an `EventEmitter` — the tap the HTTP service subscribes to for its SSE stream.
 * Unlike `LoggingAudit` (which emits formatted strings for humans), this
 * preserves the full `AuditEvent`. Persistence/querying delegate to the base.
 */
export class EmittingAudit extends EventEmitter implements AuditSink {
  constructor(private readonly base: AuditSink) {
    super();
    this.setMaxListeners(0); // many SSE clients may subscribe
  }

  async append(
    type: string,
    fields: Omit<Partial<AuditEvent>, "seq" | "at" | "type"> = {},
  ): Promise<AuditEvent> {
    const event = await this.base.append(type, fields);
    this.emit("event", event);
    return event;
  }

  load(): Promise<void> {
    return this.base.load?.() ?? Promise.resolve();
  }

  all(): readonly AuditEvent[] {
    return this.base.all();
  }
}
