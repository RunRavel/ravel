import { describe, it, expect, afterEach } from "vitest";
import { compileRegistry } from "../src/control-plane/registry.js";
import { declaredEnv } from "../src/control-plane/declaredEnv.js";
import { makeTempOrg, cleanup, agentMd } from "./helpers/tempOrg.js";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((r) => cleanup(r)));
  roots = [];
});

async function compile(files: Record<string, string>) {
  const root = await makeTempOrg({ "agent.md": agentMd("Lead"), ...files });
  roots.push(root);
  return compileRegistry(root, 1);
}

const toolsJson = (cfg: unknown) => JSON.stringify(cfg);

describe("declaredEnv", () => {
  it("returns [] for a team that declares no env anywhere", async () => {
    const result = await compile({});
    expect(result.ok).toBe(true);
    expect(declaredEnv(result.snapshot!)).toEqual([]);
  });

  it("reports a root-level env key with nodePath \"\"", async () => {
    const result = await compile({ "tools.json": toolsJson({ tools: [], env: ["ANTHROPIC_API_KEY"] }) });
    expect(declaredEnv(result.snapshot!)).toEqual([{ nodePath: "", key: "ANTHROPIC_API_KEY" }]);
  });

  it("reports both a root and a nested node's declared keys with correct nodePaths", async () => {
    const result = await compile({
      "tools.json": toolsJson({ tools: [], env: ["ANTHROPIC_API_KEY"] }),
      "growth/agent.md": agentMd("Growth", { role: "manager" }),
      "growth/copywriter/agent.md": agentMd("Copywriter", { role: "worker" }),
      "growth/copywriter/tools.json": toolsJson({ tools: [], env: ["BEACON_KEY"] }),
    });
    expect(declaredEnv(result.snapshot!)).toEqual([
      { nodePath: "", key: "ANTHROPIC_API_KEY" },
      { nodePath: "growth/copywriter", key: "BEACON_KEY" },
    ]);
  });

  it("includes stdio mcpServer env names and http/sse header ${KEY} refs, deduped against tools.json env", async () => {
    const result = await compile({
      "worker/agent.md": agentMd("Worker", { role: "worker" }),
      "worker/tools.json": toolsJson({
        tools: [],
        env: ["SERVICE_KEY"],
        mcpServers: {
          local: { type: "stdio", command: "x", env: ["STDIO_KEY"] },
          remote: { type: "http", url: "https://x.example/mcp", headers: { Authorization: "Bearer ${SERVICE_KEY}" } },
        },
      }),
    });
    expect(declaredEnv(result.snapshot!)).toEqual([
      { nodePath: "worker", key: "SERVICE_KEY" },
      { nodePath: "worker", key: "STDIO_KEY" },
    ]);
  });

  it("returns [] when the checkout fails to compile", async () => {
    const result = await compile({ "ravel.json": "{ not valid json" });
    expect(result.ok).toBe(false);
    expect(result.snapshot).toBeNull();
  });
});
