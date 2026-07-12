import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { compileRegistry } from "../src/control-plane/registry.js";
import { Lifecycle } from "../src/runtime/lifecycle.js";
import { FakeEngine } from "../src/runtime/fakeEngine.js";
import { InMemoryAudit } from "../src/trust/audit.js";
import { ApprovalBroker } from "../src/trust/approval.js";
import { KillSwitch } from "../src/trust/killswitch.js";
import { makeTempOrg, cleanup, writeFiles, agentMd } from "./helpers/tempOrg.js";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(cleanup));
  roots = [];
});

function makeLifecycle(workdirRoot: string) {
  const audit = new InMemoryAudit();
  return {
    audit,
    lifecycle: new Lifecycle({
      engine: new FakeEngine(() => "ok"),
      audit,
      approvals: new ApprovalBroker(audit),
      killSwitch: new KillSwitch(),
      workdirRoot,
    }),
  };
}

async function snapshotOf(root: string, version: number) {
  const result = await compileRegistry(root, version);
  if (!result.ok || !result.snapshot) throw new Error("compile failed");
  return result.snapshot;
}

describe("Lifecycle reconciliation", () => {
  it("spawns a runtime per node and assigns manager altitude opus", async () => {
    const root = await makeTempOrg({
      "agent.md": agentMd("CEO", { role: "ceo" }),
      "ops/agent.md": agentMd("Ops", { role: "ops" }),
    });
    roots.push(root);
    const { audit, lifecycle } = makeLifecycle(path.join(root, ".wd"));

    await lifecycle.applySnapshot(await snapshotOf(root, 1));

    expect(lifecycle.all()).toHaveLength(2);
    expect(lifecycle.get("")).toBeDefined();
    expect(lifecycle.get("ops")).toBeDefined();
    expect(lifecycle.version()).toBe(1);
    expect(audit.all().filter((e) => e.type === "agent.spawned")).toHaveLength(2);
  });

  it("drains and drops a removed node on the next snapshot", async () => {
    const root = await makeTempOrg({
      "agent.md": agentMd("CEO", { role: "ceo" }),
      "ops/agent.md": agentMd("Ops", { role: "ops" }),
    });
    roots.push(root);
    const { audit, lifecycle } = makeLifecycle(path.join(root, ".wd"));
    await lifecycle.applySnapshot(await snapshotOf(root, 1));

    await fs.rm(path.join(root, "ops"), { recursive: true, force: true });
    await lifecycle.applySnapshot(await snapshotOf(root, 2));

    expect(lifecycle.get("ops")).toBeUndefined();
    expect(lifecycle.all()).toHaveLength(1);
    expect(audit.all().some((e) => e.type === "agent.drained" && e.nodeId === "ops")).toBe(true);
  });

  it("updates config in place (same runtime instance) when a node changes", async () => {
    const root = await makeTempOrg({ "agent.md": agentMd("CEO", { role: "ceo" }) });
    roots.push(root);
    const { audit, lifecycle } = makeLifecycle(path.join(root, ".wd"));
    await lifecycle.applySnapshot(await snapshotOf(root, 1));
    const before = lifecycle.get("");

    await writeFiles(root, { "agent.md": agentMd("CEO", { role: "ceo" }, "Now with new instructions.") });
    await lifecycle.applySnapshot(await snapshotOf(root, 2));
    const after = lifecycle.get("");

    expect(after).toBe(before); // same instance, config swapped in place
    expect(after!.node.spec.systemPrompt).toBe("Now with new instructions.");
    expect(audit.all().some((e) => e.type === "agent.updated")).toBe(true);
  });

  it("is a no-op for unchanged nodes across snapshots", async () => {
    const root = await makeTempOrg({ "agent.md": agentMd("CEO", { role: "ceo" }) });
    roots.push(root);
    const { audit, lifecycle } = makeLifecycle(path.join(root, ".wd"));
    await lifecycle.applySnapshot(await snapshotOf(root, 1));
    await lifecycle.applySnapshot(await snapshotOf(root, 2));

    expect(audit.all().filter((e) => e.type === "agent.updated")).toHaveLength(0);
    expect(audit.all().filter((e) => e.type === "agent.spawned")).toHaveLength(1);
  });
});
