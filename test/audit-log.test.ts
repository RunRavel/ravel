import { describe, it, expect } from "vitest";
import { InMemoryAudit, LoggingAudit, formatEvent, levelFor, type AuditEvent } from "../src/trust/audit.js";

describe("levelFor", () => {
  it("classifies config.warning and registry.invalid as warn", () => {
    expect(levelFor({ seq: 1, at: "t", type: "config.warning", data: {} })).toBe("warn");
    expect(levelFor({ seq: 1, at: "t", type: "registry.invalid", data: {} })).toBe("warn");
  });
  it("classifies *_failed events as error", () => {
    expect(levelFor({ seq: 1, at: "t", type: "plugin.load_failed", data: {} })).toBe("error");
    expect(levelFor({ seq: 1, at: "t", type: "proposal.execute_failed", data: {} })).toBe("error");
  });
  it("classifies a failed task/process finish as error, aborted/budget_exhausted as warn", () => {
    expect(levelFor({ seq: 1, at: "t", type: "task.finished", data: { status: "failed" } })).toBe("error");
    expect(levelFor({ seq: 1, at: "t", type: "process.finished", data: { status: "aborted" } })).toBe("warn");
    expect(levelFor({ seq: 1, at: "t", type: "task.finished", data: { status: "completed" } })).toBe("info");
  });
  it("defaults to info", () => {
    expect(levelFor({ seq: 1, at: "t", type: "agent.spawned", data: {} })).toBe("info");
  });
});

describe("formatEvent — config.warning rendering", () => {
  it("renders where + message (not a bare event type)", () => {
    const e: AuditEvent = {
      seq: 1,
      at: "t",
      type: "config.warning",
      data: { where: "worker/tools.json", message: "grants generic memory write \"mem_text_set\"" },
    };
    const line = formatEvent(e);
    expect(line).toContain("worker/tools.json");
    expect(line).toContain("mem_text_set");
    expect(line).not.toBe("· config.warning"); // the bug: used to render nothing but the type
  });
});

describe("LoggingAudit — log format", () => {
  it("pretty format (default) emits the human-readable line", async () => {
    const lines: string[] = [];
    const audit = new LoggingAudit(new InMemoryAudit(), (l) => lines.push(l));
    await audit.append("agent.spawned", { nodeId: "growth" });
    expect(lines[0]).toContain("·");
    expect(lines[0]).toContain("agent.spawned");
    expect(() => JSON.parse(lines[0]!)).toThrow();
  });

  it("json format emits one NDJSON object per event with a level", async () => {
    const lines: string[] = [];
    const audit = new LoggingAudit(new InMemoryAudit(), (l) => lines.push(l), "json");
    await audit.append("config.warning", { data: { where: "x", message: "y" } });
    const parsed = JSON.parse(lines[0]!) as AuditEvent & { level: string };
    expect(parsed.type).toBe("config.warning");
    expect(parsed.level).toBe("warn");
    expect(parsed.data).toEqual({ where: "x", message: "y" });
  });
});
