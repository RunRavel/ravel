import { describe, it, expect } from "vitest";
import { parseAgentSpec } from "../src/schemas/agent.js";
import { parseToolsConfig } from "../src/schemas/tools.js";
import { parseProcessSpec } from "../src/schemas/process.js";
import { resolveModel } from "../src/schemas/common.js";

describe("agent.md parsing", () => {
  it("parses frontmatter + body into spec with body as system prompt", () => {
    const spec = parseAgentSpec(
      "---\nname: Sales Manager\nrole: manager\nmodel: opus\n---\nYou manage the sales team.",
    );
    expect(spec.name).toBe("Sales Manager");
    expect(spec.role).toBe("manager");
    expect(spec.model).toBe("opus");
    expect(spec.systemPrompt).toBe("You manage the sales team.");
    expect(spec.autonomy).toBe("orchestrated"); // default
  });

  it("rejects an agent.md with an empty body", () => {
    expect(() => parseAgentSpec("---\nname: X\n---\n")).toThrow();
  });

  it("rejects unknown frontmatter keys (strict)", () => {
    expect(() => parseAgentSpec("---\nname: X\nbogus: 1\n---\nbody")).toThrow();
  });

  it("parses a budget block", () => {
    const spec = parseAgentSpec(
      "---\nname: X\nbudget:\n  tokens: 50000\n  turns: 3\n---\nbody",
    );
    expect(spec.budget).toEqual({ tokens: 50000, turns: 3 });
  });
});

describe("tools.json parsing", () => {
  it("applies default ask policy and parses mcp servers", () => {
    const cfg = parseToolsConfig(
      JSON.stringify({
        tools: [{ name: "send_email" }, { name: "search", policy: "auto" }],
        mcpServers: { gmail: { type: "stdio", command: "gmail-mcp" } },
      }),
    );
    expect(cfg.tools[0]).toMatchObject({ name: "send_email", policy: "ask" });
    expect(cfg.tools[1]).toMatchObject({ name: "search", policy: "auto" });
    expect(cfg.mcpServers.gmail).toMatchObject({ type: "stdio", command: "gmail-mcp" });
    expect(cfg.defaultPolicy).toBe("ask");
  });

  it("rejects an invalid permission policy", () => {
    expect(() => parseToolsConfig(JSON.stringify({ tools: [{ name: "x", policy: "yolo" }] }))).toThrow();
  });

  it("rejects an mcp server with an unknown type", () => {
    expect(() => parseToolsConfig(JSON.stringify({ mcpServers: { x: { type: "carrier-pigeon" } } }))).toThrow();
  });
});

describe("process.md parsing", () => {
  it("parses a manual process with DoD and defaults", () => {
    const spec = parseProcessSpec(
      "---\nname: Outreach\nowner: manager\ndefinitionOfDone: A draft email exists.\n---\n1. Research\n2. Draft",
    );
    expect(spec.name).toBe("Outreach");
    expect(spec.owner).toBe("manager");
    expect(spec.trigger).toEqual({ type: "manual" });
    expect(spec.participants).toEqual([]);
    expect(spec.playbook).toContain("Research");
  });

  it("parses a scheduled trigger", () => {
    const spec = parseProcessSpec(
      "---\nname: Daily\nowner: manager\ndefinitionOfDone: done\ntrigger:\n  type: schedule\n  cron: '0 9 * * *'\n---\nstep",
    );
    expect(spec.trigger).toEqual({ type: "schedule", cron: "0 9 * * *" });
  });

  it("rejects a process missing definitionOfDone", () => {
    expect(() => parseProcessSpec("---\nname: X\nowner: m\n---\nbody")).toThrow();
  });
});

describe("model resolution", () => {
  it("resolves tiers to concrete ids and passes through explicit ids", () => {
    expect(resolveModel("opus", "sonnet")).toBe("claude-opus-4-8");
    expect(resolveModel(undefined, "sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModel("claude-haiku-4-5", "sonnet")).toBe("claude-haiku-4-5");
  });
});
