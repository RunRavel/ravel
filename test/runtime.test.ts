import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { AgentRuntime } from "../src/runtime/agent.js";
import { FakeEngine } from "../src/runtime/fakeEngine.js";
import { InMemoryAudit } from "../src/trust/audit.js";
import { ApprovalBroker } from "../src/trust/approval.js";
import { KillSwitch } from "../src/trust/killswitch.js";
import type { RegistryNode } from "../src/control-plane/registry.js";
import type { TaskContract, ApprovalRequest } from "../src/domain/types.js";
import { usageFor } from "../src/domain/pricing.js";
import { EMPTY_TOOLS_CONFIG, type ToolsConfig } from "../src/schemas/tools.js";

function node(overrides: Partial<RegistryNode> = {}): RegistryNode {
  return {
    id: "worker",
    dir: "/tmp/worker",
    spec: {
      name: "Worker",
      role: "worker",
      autonomy: "orchestrated",
      systemPrompt: "Do the work.",
    },
    tools: EMPTY_TOOLS_CONFIG,
    parentId: "",
    childIds: [],
    processes: [],
    ...overrides,
  };
}

function contract(overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    id: "task_1",
    assigneeNodeId: "worker",
    issuerNodeId: "",
    goal: "Summarize the inputs.",
    inputs: { topic: "widgets" },
    definitionOfDone: "A one-line summary exists.",
    budget: {},
    ...overrides,
  };
}

let workdirRoot: string;
beforeEach(async () => {
  workdirRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-wd-"));
});
afterEach(async () => {
  await fs.rm(workdirRoot, { recursive: true, force: true });
});

function harness(opts: { dryRun?: boolean } = {}) {
  const audit = new InMemoryAudit();
  // These runtime tests exercise the interactive (blocking) gate directly.
  const approvals = new ApprovalBroker(audit, { mode: "sync", dryRun: opts.dryRun });
  const killSwitch = new KillSwitch();
  return { audit, approvals, killSwitch };
}

describe("AgentRuntime.runTask", () => {
  it("runs a task to completion and records usage + audit", async () => {
    const { audit, approvals, killSwitch } = harness();
    const engine = new FakeEngine(async (ctx) => {
      ctx.emitUsage(usageFor("claude-sonnet-4-6", 1000, 200));
      return "Summarized widgets.";
    });
    const rt = new AgentRuntime(node(), { engine, audit, approvals, killSwitch, workdirRoot });

    const result = await rt.runTask(contract());

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Summarized widgets.");
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.usd).toBeGreaterThan(0);
    expect(rt.state).toBe("idle");
    const types = audit.all().map((e) => e.type);
    expect(types).toContain("task.started");
    expect(types).toContain("task.finished");
  });

  it("creates the agent's persistent working directory", async () => {
    const { audit, approvals, killSwitch } = harness();
    const engine = new FakeEngine(() => "ok");
    const rt = new AgentRuntime(node({ id: "sales/researcher" }), {
      engine,
      audit,
      approvals,
      killSwitch,
      workdirRoot,
    });
    await rt.runTask(contract());
    const stat = await fs.stat(path.join(workdirRoot, "sales__researcher"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("routes an `ask` tool through the approval queue and honors allow", async () => {
    const { audit, approvals, killSwitch } = harness();
    const tools: ToolsConfig = {
      tools: [{ name: "send_email", policy: "ask" }],
      mcpServers: {},
      defaultPolicy: "ask",
    };
    let decision: string | undefined;
    const engine = new FakeEngine(async (ctx) => {
      decision = await ctx.useTool("send_email", { to: "a@b.com" }, "notify the lead");
      return "done";
    });
    const rt = new AgentRuntime(node({ tools }), { engine, audit, approvals, killSwitch, workdirRoot });

    approvals.once("requested", (req: ApprovalRequest) => {
      void approvals.resolve(req.id, "allow");
    });

    const result = await rt.runTask(contract());
    expect(decision).toBe("allow");
    expect(result.status).toBe("completed");
    expect(audit.all().map((e) => e.type)).toContain("approval.resolved");
  });

  it("denies tools in dry-run mode and records the intended action", async () => {
    const { audit, approvals, killSwitch } = harness({ dryRun: true });
    const tools: ToolsConfig = {
      tools: [{ name: "send_email", policy: "auto" }], // even auto is denied in dry-run
      mcpServers: {},
      defaultPolicy: "ask",
    };
    let decision: string | undefined;
    const engine = new FakeEngine(async (ctx) => {
      decision = await ctx.useTool("send_email", { to: "a@b.com" });
      return "done";
    });
    const rt = new AgentRuntime(node({ tools }), { engine, audit, approvals, killSwitch, workdirRoot });

    await rt.runTask(contract());
    expect(decision).toBe("deny");
    expect(audit.all().map((e) => e.type)).toContain("tool.dry_run");
  });

  it("terminates with budget_exhausted when token budget is exceeded", async () => {
    const { audit, approvals, killSwitch } = harness();
    const engine = new FakeEngine(async (ctx) => {
      ctx.emitUsage(usageFor("claude-sonnet-4-6", 5000, 5000)); // 10k > 8k budget
      // A well-behaved engine stops when aborted; simulate by checking.
      return ctx.aborted() ? "stopped" : "kept going";
    });
    const rt = new AgentRuntime(node(), { engine, audit, approvals, killSwitch, workdirRoot });

    const result = await rt.runTask(contract({ budget: { tokens: 8000 } }));
    expect(result.status).toBe("budget_exhausted");
  });

  it("returns aborted when the agent is killed before running", async () => {
    const { audit, approvals, killSwitch } = harness();
    const engine = new FakeEngine(() => "should not run");
    const rt = new AgentRuntime(node(), { engine, audit, approvals, killSwitch, workdirRoot });

    killSwitch.kill("worker");
    const result = await rt.runTask(contract());
    expect(result.status).toBe("aborted");
  });

  it("propagates cache read/write tokens into the task result", async () => {
    const { audit, approvals, killSwitch } = harness();
    const engine = new FakeEngine(async (ctx) => {
      // Simulate a cached turn: mostly cache-read, some uncached input + output.
      ctx.emitUsage(usageFor("claude-sonnet-4-6", 500, 200, 8000, 1000));
      return "done";
    });
    const rt = new AgentRuntime(node(), { engine, audit, approvals, killSwitch, workdirRoot });
    const result = await rt.runTask(contract());

    expect(result.usage.inputTokens).toBe(500);
    expect(result.usage.cacheReadTokens).toBe(8000);
    expect(result.usage.cacheCreationTokens).toBe(1000);
    // Cost is cache-aware, far below full price for 9700 tokens of input.
    expect(result.usage.usd).toBeCloseTo((500 * 3 + 200 * 15 + 8000 * 3 * 0.1 + 1000 * 3 * 1.25) / 1e6, 9);
  });

  it("scopes built-in tools and caps turns per call type", async () => {
    const { audit, approvals, killSwitch } = harness();
    // A capturing engine records the request it was handed.
    const captured: Array<{ builtinTools: string[]; maxTurns?: number }> = [];
    const engine = {
      async run(req: import("../src/runtime/engine.js").EngineRequest) {
        captured.push({ builtinTools: req.builtinTools, ...(req.maxTurns !== undefined ? { maxTurns: req.maxTurns } : {}) });
        return { text: "ok", usage: usageFor("claude-sonnet-4-6", 0, 0), stopReason: "done" as const, toolUses: [] };
      },
    };

    // Plain worker (no grants): read-only tools, generous worker turn backstop.
    const plain = new AgentRuntime(node(), { engine, audit, approvals, killSwitch, workdirRoot });
    await plain.runTask(contract());
    expect(captured[0]!.builtinTools).toEqual(["Read", "Glob", "Grep"]);
    expect(captured[0]!.maxTurns).toBe(45);

    // Planning/ask: no tools at all, lower turn cap.
    await plain.ask("plan something");
    expect(captured[1]!.builtinTools).toEqual([]);
    expect(captured[1]!.maxTurns).toBe(12);

    // `builtins: "none"` withholds Read/Glob/Grep (for memory-only agents), but
    // explicitly-granted built-ins (WebSearch) are still exposed.
    const noFiles = new AgentRuntime(
      node({ tools: { tools: [{ name: "WebSearch", policy: "auto" }], mcpServers: {}, defaultPolicy: "ask", builtins: "none" } }),
      { engine, audit, approvals, killSwitch, workdirRoot },
    );
    await noFiles.runTask(contract());
    expect(captured[2]!.builtinTools).toEqual(["WebSearch"]);
    expect(captured[2]!.builtinTools).not.toContain("Read");

    // An agent that explicitly grants Bash gets it added to the read-only set.
    const withBash = new AgentRuntime(
      node({ tools: { tools: [{ name: "Bash", policy: "auto" }], mcpServers: {}, defaultPolicy: "ask" } }),
      { engine, audit, approvals, killSwitch, workdirRoot },
    );
    await withBash.runTask(contract());
    expect(captured[3]!.builtinTools).toContain("Bash");
    expect(captured[3]!.builtinTools).toContain("Read");
  });

  it("tracks live activity and emits tool.started, clearing activity when idle", async () => {
    const { audit, approvals, killSwitch } = harness();
    const tools: ToolsConfig = {
      tools: [{ name: "search", policy: "auto" }],
      mcpServers: {},
      defaultPolicy: "auto",
    };
    let goalDuringRun: string | undefined;
    let toolDuringRun: string | undefined;
    const engine = new FakeEngine(async (ctx) => {
      await ctx.useTool("search", { q: "robots" });
      goalDuringRun = rt.activity.taskGoal;
      toolDuringRun = rt.activity.currentTool;
      return "done";
    });
    const rt = new AgentRuntime(node({ tools }), { engine, audit, approvals, killSwitch, workdirRoot });

    await rt.runTask(contract({ goal: "Find robotics signals" }));

    expect(goalDuringRun).toBe("Find robotics signals");
    expect(toolDuringRun).toBe("search");
    // Activity is cleared once the run finishes.
    expect(rt.activity).toEqual({});
    expect(audit.all().some((e) => e.type === "tool.started" && e.data["tool"] === "search")).toBe(true);
  });

  it("denies further tool use once the budget is spent", async () => {
    const { audit, approvals, killSwitch } = harness();
    const tools: ToolsConfig = {
      tools: [{ name: "search", policy: "auto" }],
      mcpServers: {},
      defaultPolicy: "auto",
    };
    const decisions: string[] = [];
    const engine = new FakeEngine(async (ctx) => {
      decisions.push(await ctx.useTool("search", { q: "1" })); // allowed
      ctx.emitUsage(usageFor("claude-sonnet-4-6", 9000, 0)); // blow the budget
      decisions.push(await ctx.useTool("search", { q: "2" })); // now denied
      return "done";
    });
    const rt = new AgentRuntime(node({ tools }), { engine, audit, approvals, killSwitch, workdirRoot });

    await rt.runTask(contract({ budget: { tokens: 8000 } }));
    expect(decisions).toEqual(["allow", "deny"]);
  });
});
