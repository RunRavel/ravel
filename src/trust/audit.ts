import { promises as fs } from "node:fs";
import path from "node:path";
import { systemClock, type Clock } from "../domain/ids.js";

/**
 * One entry in the append-only audit trail. Every decision, message, tool call,
 * approval, and lifecycle transition is recorded so a run can be fully
 * reconstructed and reviewed. This is non-negotiable for a system a business
 * owner must trust.
 */
export interface AuditEvent {
  /** Monotonic sequence within the sink. */
  seq: number;
  at: string;
  type: string;
  nodeId?: string;
  runId?: string;
  data: Record<string, unknown>;
}

export interface AuditSink {
  append(type: string, fields: Omit<Partial<AuditEvent>, "seq" | "at" | "type">): Promise<AuditEvent>;
  all(): readonly AuditEvent[];
  /** Rehydrate prior events from durable storage (called once at startup). */
  load?(): Promise<void>;
}

/** How the verbose stream (`-v`) renders each event: human-readable, or NDJSON for log aggregators. */
export type LogFormat = "pretty" | "json";

/**
 * Coarse severity for an audit event, used by JSON-format logging so an
 * aggregator (Datadog, CloudWatch, Loki) can filter/alert without parsing
 * prose. Best-effort classification, not exhaustive.
 */
export function levelFor(e: AuditEvent): "info" | "warn" | "error" {
  if (e.type.endsWith("_failed") || e.type === "task.unrouted") return "error";
  if (e.type === "config.warning" || e.type === "registry.invalid" || e.type === "plugin.action_conflict") return "warn";
  const status = e.data["status"];
  if ((e.type === "task.finished" || e.type === "process.finished") && status === "failed") return "error";
  if ((e.type === "task.finished" || e.type === "process.finished") && (status === "aborted" || status === "budget_exhausted")) {
    return "warn";
  }
  return "info";
}

/** In-memory audit sink — used in tests and as the dashboard's live buffer. */
export class InMemoryAudit implements AuditSink {
  private readonly events: AuditEvent[] = [];
  private seq = 0;
  constructor(private readonly clock: Clock = systemClock) {}

  async append(
    type: string,
    fields: Omit<Partial<AuditEvent>, "seq" | "at" | "type"> = {},
  ): Promise<AuditEvent> {
    const event: AuditEvent = {
      seq: ++this.seq,
      at: this.clock.iso(),
      type,
      data: {},
      ...fields,
    };
    this.events.push(event);
    return event;
  }

  /** Load prior events as-is, preserving their seq and continuing the counter. */
  hydrate(events: AuditEvent[]): void {
    for (const e of events) {
      this.events.push(e);
      if (e.seq > this.seq) this.seq = e.seq;
    }
  }

  all(): readonly AuditEvent[] {
    return this.events;
  }
}

/**
 * Durable JSONL audit sink that also keeps an in-memory mirror for querying.
 * Writes are serialized so the file is a faithful, ordered record.
 */
/**
 * Wraps any AuditSink and tees each event to a sink function (e.g. stderr) for
 * live verbose logging. Persistence/querying delegate to the wrapped sink, so
 * `-v` adds visibility without changing where the audit trail is stored.
 */
export class LoggingAudit implements AuditSink {
  constructor(
    private readonly base: AuditSink,
    private readonly emit: (line: string) => void,
    /** Default "pretty" (human-readable). "json" emits one NDJSON object per event. */
    private readonly format: LogFormat = "pretty",
  ) {}

  async append(
    type: string,
    fields: Omit<Partial<AuditEvent>, "seq" | "at" | "type"> = {},
  ): Promise<AuditEvent> {
    const event = await this.base.append(type, fields);
    this.emit(this.format === "json" ? JSON.stringify({ ...event, level: levelFor(event) }) : formatEvent(event));
    return event;
  }

  load(): Promise<void> {
    return this.base.load?.() ?? Promise.resolve();
  }

  all(): readonly AuditEvent[] {
    return this.base.all();
  }
}

/** Compact one-line rendering of an audit event for verbose logs. */
export function formatEvent(e: AuditEvent): string {
  const where = [e.nodeId !== undefined ? `node=${e.nodeId || "(root)"}` : "", e.runId ? `run=${e.runId}` : ""]
    .filter(Boolean)
    .join(" ");
  const d = e.data;
  let detail = "";
  switch (e.type) {
    case "process.started":
      detail = `process="${d["process"]}"`;
      break;
    case "process.turn":
      detail = `turn=${d["turn"]} done=${d["done"]} tasks=${d["taskCount"]}${d["assignees"] ? ` → [${(d["assignees"] as string[]).join(", ")}]` : ""}`;
      break;
    case "process.finished":
      detail = `status=${d["status"]} turns=${d["turns"]}`;
      break;
    case "task.started":
      detail = `goal="${String(d["goal"] ?? "").slice(0, 80)}"`;
      break;
    case "task.finished":
      detail = `status=${d["status"]}${d["summary"] ? ` — ${String(d["summary"]).slice(0, 100).replace(/\s+/g, " ")}` : ""}`;
      break;
    case "task.unrouted":
      detail = `role="${d["role"]}"`;
      break;
    case "approval.requested":
      detail = `tool=${d["tool"]} ⏸ awaiting human`;
      break;
    case "approval.resolved":
      detail = `tool=${d["tool"]} → ${d["decision"]}`;
      break;
    case "tool.started":
    case "tool.auto_allowed":
    case "tool.denied_by_policy":
    case "tool.dry_run":
      detail = `tool=${d["tool"]}`;
      break;
    case "tool.finished": {
      const out = d["output"];
      const outStr = out === undefined ? "" : ` → ${String(typeof out === "string" ? out : JSON.stringify(out)).slice(0, 80).replace(/\s+/g, " ")}`;
      detail = `tool=${d["tool"]}${outStr}`;
      break;
    }
    case "message.deadletter":
      detail = `reason=${d["reason"]}`;
      break;
    case "registry.invalid":
      detail = `${(d["diagnostics"] as string[] | undefined)?.length ?? 0} diagnostic(s)`;
      break;
    case "config.warning":
      detail = `${d["where"]}: ${d["message"]}`;
      break;
    default:
      detail = "";
  }
  return `· ${e.type}${where ? ` ${where}` : ""}${detail ? ` ${detail}` : ""}`;
}

export class JsonlAudit implements AuditSink {
  private readonly mem: InMemoryAudit;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly clock: Clock = systemClock,
  ) {
    this.mem = new InMemoryAudit(clock);
  }

  /** Rehydrate the in-memory mirror from the JSONL file so history survives restarts. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const events: AuditEvent[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim()) {
        try {
          events.push(JSON.parse(line) as AuditEvent);
        } catch {
          /* skip a partially-written trailing line */
        }
      }
    }
    this.mem.hydrate(events);
  }

  async append(
    type: string,
    fields: Omit<Partial<AuditEvent>, "seq" | "at" | "type"> = {},
  ): Promise<AuditEvent> {
    const event = await this.mem.append(type, fields);
    const line = `${JSON.stringify(event)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, line, "utf8");
    });
    await this.writeChain;
    return event;
  }

  all(): readonly AuditEvent[] {
    return this.mem.all();
  }
}
