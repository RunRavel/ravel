import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { InMemoryAudit } from "../src/trust/audit.js";
import { PluginRegistry } from "../src/plugins/loader.js";
import { assembleMcpServers } from "../src/runtime/sdkEngine.js";
import { MemoryStore } from "../src/memory/store.js";
import { EMPTY_TOOLS_CONFIG, type ToolsConfig } from "../src/schemas/tools.js";
import type { RegistryNode, RegistrySnapshot } from "../src/control-plane/registry.js";
import type { EngineRequest } from "../src/runtime/engine.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function node(id: string, pluginPath: string): RegistryNode {
  return {
    id,
    dir: path.join(FIXTURES, id),
    spec: { name: id, role: id, autonomy: "orchestrated", systemPrompt: "x" },
    tools: EMPTY_TOOLS_CONFIG,
    parentId: null,
    childIds: [],
    processes: [],
    pluginPath,
  };
}

function snapshot(nodes: RegistryNode[]): RegistrySnapshot {
  return {
    version: 1,
    root: FIXTURES,
    rootId: "",
    nodes: new Map(nodes.map((n) => [n.id, n])),
    processes: [],
  };
}

describe("PluginRegistry", () => {
  it("loads a valid plugin and exposes its tools/actions", async () => {
    const audit = new InMemoryAudit();
    const reg = new PluginRegistry(FIXTURES, audit);
    await reg.syncFromSnapshot(snapshot([node("good", "plugins/good.ts")]));

    const plugin = reg.forNode("good");
    expect(plugin?.name).toBe("fixture-good");
    expect(plugin?.tools?.map((t) => t.name)).toEqual(["echo"]);
    expect(plugin?.actions?.map((a) => a.name)).toEqual(["do_thing"]);
    expect(audit.all().some((e) => e.type === "plugin.loaded")).toBe(true);
  });

  it("audits and skips a plugin that throws on import (agent still runs)", async () => {
    const audit = new InMemoryAudit();
    const reg = new PluginRegistry(FIXTURES, audit);
    await reg.syncFromSnapshot(snapshot([node("bad", "plugins/bad.ts")]));

    expect(reg.forNode("bad")).toBeUndefined();
    expect(audit.all().some((e) => e.type === "plugin.load_failed")).toBe(true);
  });

  it("rejects a default export that isn't a valid plugin definition", async () => {
    const audit = new InMemoryAudit();
    const reg = new PluginRegistry(FIXTURES, audit);
    await reg.syncFromSnapshot(snapshot([node("invalid", "plugins/invalid.ts")]));

    expect(reg.forNode("invalid")).toBeUndefined();
    expect(audit.all().some((e) => e.type === "plugin.load_failed")).toBe(true);
  });

  it("inherits a team-root plugin to descendants (one owning entry, no action dup)", async () => {
    const audit = new InMemoryAudit();
    const reg = new PluginRegistry(FIXTURES, audit);
    const parent = node("good", "plugins/good.ts"); // declares the plugin
    const child: RegistryNode = {
      id: "good/child",
      dir: path.join(FIXTURES, "good", "child"),
      spec: { name: "child", role: "child", autonomy: "orchestrated", systemPrompt: "x" },
      tools: EMPTY_TOOLS_CONFIG,
      parentId: "good",
      childIds: [],
      processes: [],
      // no pluginPath of its own → must inherit the parent's
    };
    await reg.syncFromSnapshot(snapshot([parent, child]));

    expect(reg.forNode("good/child")?.name).toBe("fixture-good"); // inherited
    expect(reg.all()).toHaveLength(1); // owning node only → actions register once
  });

  it("only attempts each node once (load-once; code changes need restart)", async () => {
    const audit = new InMemoryAudit();
    const reg = new PluginRegistry(FIXTURES, audit);
    const snap = snapshot([node("good", "plugins/good.ts")]);
    await reg.syncFromSnapshot(snap);
    await reg.syncFromSnapshot(snap); // second sync is a no-op
    expect(audit.all().filter((e) => e.type === "plugin.loaded")).toHaveLength(1);
  });
});

describe("assembleMcpServers — plugin server", () => {
  it("builds a `plugin` server from granted plugin tools", () => {
    const tools: ToolsConfig = {
      tools: [{ name: "echo", policy: "auto" }],
      mcpServers: {},
      env: [],
      defaultPolicy: "ask",
    };
    const req: EngineRequest = {
      systemPrompt: "x",
      model: "claude-sonnet-4-6",
      prompt: "x",
      tools,
      builtinTools: [],
      cwd: "/tmp",
      signal: new AbortController().signal,
      decide: async () => "allow",
      toolContext: {
        nodeId: "scribe",
        managerNodeId: "",
        memory: new MemoryStore("/tmp/x"),
        pluginTools: [
          {
            name: "echo",
            description: "echo",
            schema: { msg: z.string() },
            handler: async (i: Record<string, unknown>) => ({ echoed: i["msg"] }),
          },
        ],
        pluginEnv: {},
      },
    };
    expect(Object.keys(assembleMcpServers(req))).toContain("plugin");

    // Not granted → no plugin server.
    const ungranted = { ...req, tools: EMPTY_TOOLS_CONFIG };
    expect(Object.keys(assembleMcpServers(ungranted))).not.toContain("plugin");
  });
});
