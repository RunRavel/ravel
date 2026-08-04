import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { AgentRuntime } from "../src/runtime/agent.js";
import { FakeEngine } from "../src/runtime/fakeEngine.js";
import { TranscriptStore } from "../src/runtime/transcript.js";
import { InMemoryAudit } from "../src/trust/audit.js";
import { ApprovalBroker } from "../src/trust/approval.js";
import { KillSwitch } from "../src/trust/killswitch.js";
import type { RegistryNode } from "../src/control-plane/registry.js";
import type { TaskContract } from "../src/domain/types.js";
import { EMPTY_TOOLS_CONFIG } from "../src/schemas/tools.js";

function node(overrides: Partial<RegistryNode> = {}): RegistryNode {
  return {
    id: "worker",
    dir: "/tmp/worker",
    spec: { name: "Worker", role: "worker", autonomy: "orchestrated", systemPrompt: "Do the work." },
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
    inputs: {},
    definitionOfDone: "A one-line summary exists.",
    budget: {},
    runId: "run_1",
    ...overrides,
  };
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-transcript-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("TranscriptStore", () => {
  it("returns [] for a run that never wrote anything", async () => {
    const store = new TranscriptStore(tmp);
    expect(await store.read("no-such-run")).toEqual([]);
  });

  it("persists appended entries, oldest-first, across separate append() calls", async () => {
    const store = new TranscriptStore(tmp);
    await store.append("run_1", [{ at: "t1", nodeId: "worker", type: "text", text: "first" }]);
    await store.append("run_1", [{ at: "t2", nodeId: "worker", type: "text", text: "second" }]);
    const entries = await store.read("run_1");
    expect(entries.map((e) => e.text)).toEqual(["first", "second"]);
  });

  it("writes to <runsRoot>/<runId>/transcript.jsonl", async () => {
    const store = new TranscriptStore(tmp);
    await store.append("run_42", [{ at: "t1", nodeId: "worker", type: "text", text: "hi" }]);
    const raw = await fs.readFile(path.join(tmp, "run_42", "transcript.jsonl"), "utf8");
    expect(JSON.parse(raw.trim())).toMatchObject({ text: "hi" });
  });

  it("a no-op append (empty entries) never creates a file", async () => {
    const store = new TranscriptStore(tmp);
    await store.append("run_1", []);
    await expect(fs.access(path.join(tmp, "run_1", "transcript.jsonl"))).rejects.toThrow();
  });
});

describe("AgentRuntime — opt-in transcript capture (WO-021 / ask #25)", () => {
  it("captures intermediate-turn text via the engine's transcript, attributed with contractId, when transcripts are configured", async () => {
    const audit = new InMemoryAudit();
    const approvals = new ApprovalBroker(audit, { mode: "sync" });
    const killSwitch = new KillSwitch();
    const transcripts = new TranscriptStore(tmp);
    const engine = new FakeEngine((ctx) => {
      ctx.emitTranscriptText("thinking out loud, turn one");
      ctx.emitTranscriptText("final answer");
      return "final answer";
    });
    const rt = new AgentRuntime(node(), { engine, audit, approvals, killSwitch, workdirRoot: tmp, transcripts });

    await rt.runTask(contract());

    const entries = await transcripts.read("run_1");
    expect(entries.map((e) => e.text)).toEqual(["thinking out loud, turn one", "final answer"]);
    expect(entries[0]!.contractId).toBe("task_1");
    expect(entries[0]!.nodeId).toBe("worker");
  });

  it("captures nothing when transcripts are not configured — no file, no error", async () => {
    const audit = new InMemoryAudit();
    const approvals = new ApprovalBroker(audit, { mode: "sync" });
    const killSwitch = new KillSwitch();
    const engine = new FakeEngine((ctx) => {
      ctx.emitTranscriptText("should be dropped — capture wasn't requested");
      return "ok";
    });
    // No `transcripts` dep at all.
    const rt = new AgentRuntime(node(), { engine, audit, approvals, killSwitch, workdirRoot: tmp });
    const result = await rt.runTask(contract());
    expect(result.status).toBe("completed");
    // Nothing to read back — the store was never even constructed for this runtime.
    const store = new TranscriptStore(tmp);
    expect(await store.read("run_1")).toEqual([]);
  });

  it("captures nothing for a call with no runId (e.g. chat) even with transcripts configured", async () => {
    const audit = new InMemoryAudit();
    const approvals = new ApprovalBroker(audit, { mode: "sync" });
    const killSwitch = new KillSwitch();
    const transcripts = new TranscriptStore(tmp);
    const engine = new FakeEngine((ctx) => {
      ctx.emitTranscriptText("chat has no runId to file this under");
      return "reply";
    });
    const rt = new AgentRuntime(node(), { engine, audit, approvals, killSwitch, workdirRoot: tmp, transcripts });
    await rt.chat("hello");
    // FakeEngine only pushes into its transcript array when req.captureTranscript
    // is true; chat's runEngine call has no runId, so captureTranscript is false.
    // (The agent's own workdir is still created under `tmp` — that's unrelated.)
    async function findTranscriptFiles(dir: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const found: string[] = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) found.push(...(await findTranscriptFiles(full)));
        else if (e.name === "transcript.jsonl") found.push(full);
      }
      return found;
    }
    expect(await findTranscriptFiles(tmp)).toEqual([]);
  });

  it("bumps task.finished.summary's cap to ~8000 characters", async () => {
    const audit = new InMemoryAudit();
    const approvals = new ApprovalBroker(audit, { mode: "sync" });
    const killSwitch = new KillSwitch();
    const longText = "x".repeat(9000);
    const engine = new FakeEngine(() => longText);
    const rt = new AgentRuntime(node(), { engine, audit, approvals, killSwitch, workdirRoot: tmp });
    await rt.runTask(contract());
    const finished = audit.all().find((e) => e.type === "task.finished")!;
    expect((finished.data["summary"] as string).length).toBe(8000);
  });
});
