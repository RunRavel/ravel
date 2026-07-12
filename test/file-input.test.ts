import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { compileRegistry, type RegistrySnapshot } from "../src/control-plane/registry.js";
import { Lifecycle } from "../src/runtime/lifecycle.js";
import { FakeEngine } from "../src/runtime/fakeEngine.js";
import { InMemoryAudit } from "../src/trust/audit.js";
import { ApprovalBroker } from "../src/trust/approval.js";
import { KillSwitch } from "../src/trust/killswitch.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { Plan, Planner } from "../src/orchestrator/planner.js";
import { emptyUsage } from "../src/domain/types.js";
import { makeTempOrg, cleanup, agentMd } from "./helpers/tempOrg.js";

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => cleanup(d)));
  dirs = [];
});

describe("source file input", () => {
  it("stages a provided file into the assignee's working directory and exposes it", async () => {
    const root = await makeTempOrg({
      "agent.md": agentMd("Manager", { role: "manager" }, "You manage."),
      "engineer/agent.md": agentMd("Engineer", { role: "engineer" }, "You prep files."),
      "processes/p.process.md":
        "---\nname: Localize\nowner: manager\ndefinitionOfDone: strings extracted\n---\nPrep the source file.",
    });
    dirs.push(root);

    // A real source file on the host, outside the org.
    const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-src-"));
    dirs.push(srcDir);
    const srcFile = path.join(srcDir, "en.json");
    await fs.writeFile(srcFile, JSON.stringify({ greeting: "Hello, {name}!" }), "utf8");

    const compiled = await compileRegistry(root, 1);
    const snapshot = compiled.snapshot as RegistrySnapshot;
    const workdirRoot = path.join(root, ".wd");
    const workspaceRoot = path.join(root, ".runs");
    const audit = new InMemoryAudit();

    // Engineer reads the input from the shared workspace, then writes a handoff
    // back into shared/ — exercising read + write-by-reference.
    const engine = new FakeEngine(() => "ok", [
      async (ctx) => {
        const src = await fs.readFile(path.join(ctx.req.cwd, "shared", "en.json"), "utf8");
        await fs.writeFile(path.join(ctx.req.cwd, "shared", "strings.txt"), "greeting", "utf8");
        return `read ${src.length} bytes; placeholder intact: ${src.includes("{name}")}; wrote strings.txt`;
      },
    ]);

    const lifecycle = new Lifecycle({
      engine,
      audit,
      approvals: new ApprovalBroker(audit),
      killSwitch: new KillSwitch(),
      workdirRoot,
    });
    await lifecycle.applySnapshot(snapshot);

    let turn = 0;
    const planner: Planner = {
      async plan(): Promise<Plan> {
        turn += 1;
        return turn === 1
          ? { done: false, tasks: [{ assigneeRole: "engineer", goal: "prep", definitionOfDone: "done" }], usage: emptyUsage() }
          : { done: true, summary: "prepped", tasks: [], usage: emptyUsage() };
      },
    };

    const orch = new Orchestrator({ lifecycle, planner, audit, workspaceRoot });
    const result = await orch.runProcess(snapshot.processes[0]!, snapshot, { files: [srcFile] });

    // The engineer saw the input via the shared workspace (placeholder intact).
    expect(result.results[0]!.summary).toContain("placeholder intact: true");
    // The input physically landed in the run's shared/ dir...
    const sharedDir = path.join(workspaceRoot, result.runId, "shared");
    expect(await fs.readFile(path.join(sharedDir, "en.json"), "utf8")).toContain("{name}");
    // ...and the engineer's handoff was written there too (real artifact on disk).
    expect(await fs.readFile(path.join(sharedDir, "strings.txt"), "utf8")).toBe("greeting");
    // The result points the owner at the deliverable workspace.
    expect(result.workspaceDir).toBe(sharedDir);
    expect(audit.all().some((e) => e.type === "run.file_staged")).toBe(true);
  });
});
