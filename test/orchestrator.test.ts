import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { compileRegistry, type RegistrySnapshot } from "../src/control-plane/registry.js";
import { Lifecycle } from "../src/runtime/lifecycle.js";
import { FakeEngine } from "../src/runtime/fakeEngine.js";
import { InMemoryAudit } from "../src/trust/audit.js";
import { ApprovalBroker } from "../src/trust/approval.js";
import { KillSwitch } from "../src/trust/killswitch.js";
import { Orchestrator, clampBudget } from "../src/orchestrator/orchestrator.js";
import { EnginePlanner, extractJsonObject, type Plan, type Planner } from "../src/orchestrator/planner.js";
import { emptyUsage } from "../src/domain/types.js";
import { makeTempOrg, cleanup, agentMd } from "./helpers/tempOrg.js";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(cleanup));
  roots = [];
});

const ORG = {
  "agent.md": agentMd("CEO", { role: "ceo" }, "You orchestrate."),
  "researcher/agent.md": agentMd("Researcher", { role: "researcher" }, "You research."),
  "processes/outreach.process.md":
    "---\nname: Outreach\nowner: ceo\nparticipants: [researcher]\ndefinitionOfDone: A research summary exists.\n---\n1. Research the prospect.\n2. Summarize.",
};

async function setup(engine: FakeEngine) {
  const root = await makeTempOrg(ORG);
  roots.push(root);
  const compiled = await compileRegistry(root, 1);
  if (!compiled.ok || !compiled.snapshot) throw new Error("compile failed");
  const snapshot: RegistrySnapshot = compiled.snapshot;

  const audit = new InMemoryAudit();
  const lifecycle = new Lifecycle({
    engine,
    audit,
    approvals: new ApprovalBroker(audit),
    killSwitch: new KillSwitch(),
    workdirRoot: path.join(root, ".wd"),
  });
  await lifecycle.applySnapshot(snapshot);
  return { snapshot, audit, lifecycle };
}

describe("Orchestrator (injected planner)", () => {
  it("dispatches a task then completes when the owner declares done", async () => {
    const engine = new FakeEngine(() => "did the research");
    const { snapshot, audit, lifecycle } = await setup(engine);

    let turn = 0;
    const planner: Planner = {
      async plan(): Promise<Plan> {
        turn += 1;
        if (turn === 1) {
          return {
            done: false,
            tasks: [{ assigneeRole: "researcher", goal: "Research prospect", definitionOfDone: "notes exist" }],
            usage: emptyUsage(),
          };
        }
        return { done: true, summary: "Research summary complete.", tasks: [], usage: emptyUsage() };
      },
    };
    const orch = new Orchestrator({ lifecycle, planner, audit });
    const result = await orch.runProcess(snapshot.processes[0]!, snapshot);

    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Research summary complete.");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.summary).toBe("did the research");
    expect(result.turns).toBe(2);
    const types = audit.all().map((e) => e.type);
    expect(types).toContain("process.started");
    expect(types).toContain("process.finished");
  });

  it("stops with budget_exhausted when turns run out", async () => {
    const engine = new FakeEngine(() => "work");
    const { snapshot, lifecycle, audit } = await setup(engine);
    // Process budget pins turns to 2; planner never declares done.
    const proc = {
      ...snapshot.processes[0]!,
      spec: { ...snapshot.processes[0]!.spec, budget: { turns: 2 } },
    };
    const planner: Planner = {
      async plan(): Promise<Plan> {
        return {
          done: false,
          tasks: [{ assigneeRole: "researcher", goal: "loop", definitionOfDone: "never" }],
          usage: emptyUsage(),
        };
      },
    };
    const orch = new Orchestrator({ lifecycle, planner, audit });
    const result = await orch.runProcess(proc, snapshot);
    expect(result.status).toBe("budget_exhausted");
    expect(result.turns).toBe(2);
  });

  it("records an unrouted task when a role has no agent", async () => {
    const engine = new FakeEngine(() => "x");
    const { snapshot, lifecycle, audit } = await setup(engine);
    let calls = 0;
    const planner: Planner = {
      async plan(): Promise<Plan> {
        // First turn dispatches to a nonexistent role; second turn done.
        return calls++ === 0
          ? { done: false, tasks: [{ assigneeRole: "ghost", goal: "g", definitionOfDone: "d" }], usage: emptyUsage() }
          : { done: true, summary: "done", tasks: [], usage: emptyUsage() };
      },
    };
    const orch = new Orchestrator({ lifecycle, planner, audit });
    const result = await orch.runProcess(snapshot.processes[0]!, snapshot);
    expect(result.results[0]!.summary).toMatch(/No agent for role "ghost"/);
    expect(audit.all().some((e) => e.type === "task.unrouted")).toBe(true);
  });
});

describe("EnginePlanner", () => {
  it("drives a full run by parsing the owner's JSON plans", async () => {
    // FIFO programs: owner plan #1 → worker task → owner plan #2 (done).
    const engine = new FakeEngine(() => "ok", [
      () =>
        JSON.stringify({
          done: false,
          tasks: [{ assigneeRole: "researcher", goal: "Research", definitionOfDone: "notes" }],
        }),
      () => "Researched: prospect is a mid-market SaaS.",
      () => `Here is my decision: ${JSON.stringify({ done: true, summary: "All set." })}`,
    ]);
    const { snapshot, audit, lifecycle } = await setup(engine);
    const planner = new EnginePlanner((id) => lifecycle.get(id));
    const orch = new Orchestrator({ lifecycle, planner, audit });

    const result = await orch.runProcess(snapshot.processes[0]!, snapshot);
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("All set.");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.summary).toContain("mid-market SaaS");
  });
});

describe("clampBudget (per-task budget slicing)", () => {
  it("returns the remaining budget when no per-task budget is requested", () => {
    expect(clampBudget(undefined, { usd: 5, turns: 8 })).toEqual({ usd: 5, turns: 8 });
  });
  it("takes the field-wise minimum of requested and remaining", () => {
    // A small per-candidate slice stays small; a field absent from remaining passes through.
    expect(clampBudget({ usd: 0.5, turns: 6, tokens: 100 }, { usd: 5, turns: 8 })).toEqual({
      usd: 0.5,
      turns: 6,
      tokens: 100,
    });
  });
  it("never lets a task exceed what's left of the process budget", () => {
    expect(clampBudget({ usd: 99, turns: 99 }, { usd: 2, turns: 3 })).toEqual({ usd: 2, turns: 3 });
  });
});

describe("extractJsonObject", () => {
  it("pulls a balanced object out of surrounding prose", () => {
    expect(extractJsonObject('prefix {"a": 1, "b": {"c": 2}} suffix')).toEqual({ a: 1, b: { c: 2 } });
  });
  it("handles braces inside strings", () => {
    expect(extractJsonObject('{"msg": "use {curly} braces"}')).toEqual({ msg: "use {curly} braces" });
  });
  it("returns null when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });
});
