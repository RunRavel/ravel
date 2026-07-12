import { describe, it, expect, afterEach } from "vitest";
import { compileRegistry } from "../src/control-plane/registry.js";
import { makeTempOrg, cleanup, agentMd } from "./helpers/tempOrg.js";

let roots: string[] = [];
async function org(files: Record<string, string>): Promise<string> {
  const root = await makeTempOrg(files);
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.map(cleanup));
  roots = [];
});

describe("compileRegistry", () => {
  it("compiles a valid hierarchy with parent/child links", async () => {
    const root = await org({
      "agent.md": agentMd("CEO", { role: "ceo" }),
      "tools.json": JSON.stringify({ tools: [] }),
      "sales/agent.md": agentMd("Sales Manager", { role: "manager" }),
      "sales/researcher/agent.md": agentMd("Researcher", { role: "researcher" }),
    });

    const result = await compileRegistry(root, 1);
    expect(result.ok).toBe(true);
    const snap = result.snapshot!;
    expect(snap.version).toBe(1);
    expect(snap.rootId).toBe("");
    expect(snap.nodes.size).toBe(3);

    const ceo = snap.nodes.get("")!;
    expect(ceo.parentId).toBeNull();
    expect(ceo.childIds).toEqual(["sales"]);

    const sales = snap.nodes.get("sales")!;
    expect(sales.parentId).toBe("");
    expect(sales.childIds).toEqual(["sales/researcher"]);

    const researcher = snap.nodes.get("sales/researcher")!;
    expect(researcher.parentId).toBe("sales");
    expect(researcher.childIds).toEqual([]);
  });

  it("resolves a process owner by role within scope", async () => {
    const root = await org({
      "agent.md": agentMd("CEO", { role: "ceo" }),
      "sales/agent.md": agentMd("Sales Manager", { role: "manager" }),
      "processes/outreach.process.md":
        "---\nname: Outreach\nowner: manager\ndefinitionOfDone: draft exists\n---\nresearch then draft",
    });
    const result = await compileRegistry(root, 1);
    expect(result.ok).toBe(true);
    expect(result.snapshot!.processes).toHaveLength(1);
    expect(result.snapshot!.processes[0]!.ownerNodeId).toBe("sales");
    expect(result.snapshot!.processes[0]!.definedAtNodeId).toBe("");
  });

  it("fails when a process owner does not resolve", async () => {
    const root = await org({
      "agent.md": agentMd("CEO", { role: "ceo" }),
      "processes/x.process.md":
        "---\nname: X\nowner: nonexistent\ndefinitionOfDone: done\n---\nstep",
    });
    const result = await compileRegistry(root, 1);
    expect(result.ok).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.diagnostics[0]!.message).toMatch(/did not resolve/);
  });

  it("rejects the whole compile when one agent.md is invalid (keeps last-good upstream)", async () => {
    const root = await org({
      "agent.md": agentMd("CEO"),
      "broken/agent.md": "---\nname:\n---\n", // empty name + empty body
    });
    const result = await compileRegistry(root, 2);
    expect(result.ok).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.diagnostics.some((d) => d.where.includes("broken"))).toBe(true);
  });

  it("rejects invalid tools.json as a hard error for the node", async () => {
    const root = await org({
      "agent.md": agentMd("CEO"),
      "tools.json": "{ not valid json",
    });
    const result = await compileRegistry(root, 1);
    expect(result.ok).toBe(false);
  });

  it("fails when the org root has no agent.md", async () => {
    const root = await org({ "notes.txt": "hello" });
    const result = await compileRegistry(root, 1);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.message).toMatch(/no agent\.md/);
  });

  it("ignores dotfolders and the processes dir when scanning children", async () => {
    const root = await org({
      "agent.md": agentMd("CEO"),
      ".hidden/agent.md": agentMd("Ghost"),
      "processes/p.process.md":
        "---\nname: P\nowner: ceo\ndefinitionOfDone: d\n---\nstep",
    });
    const result = await compileRegistry(root, 1);
    expect(result.ok).toBe(true);
    expect(result.snapshot!.nodes.size).toBe(1);
  });
});
