import { describe, it, expect, afterEach } from "vitest";
import { compileRegistry } from "../src/control-plane/registry.js";
import { lintRegistry } from "../src/control-plane/lint.js";
import { satisfiesRange } from "../src/schemas/manifest.js";
import { SecretStore } from "../src/secrets/store.js";
import { makeTempOrg, cleanup, agentMd, writeFiles } from "./helpers/tempOrg.js";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((r) => cleanup(r)));
  roots = [];
});

async function compile(files: Record<string, string>) {
  const root = await makeTempOrg({ "agent.md": agentMd("Lead"), ...files });
  roots.push(root);
  const result = await compileRegistry(root, 1);
  return { root, result };
}

const toolsJson = (cfg: unknown) => JSON.stringify(cfg);

describe("lintRegistry — generic memory write warnings", () => {
  it("warns on a generic mem write grant, not on a read grant", async () => {
    const { root, result } = await compile({
      "worker/agent.md": agentMd("Worker", { role: "worker" }),
      "worker/tools.json": toolsJson({
        tools: [
          { name: "mem_text_set", policy: "auto" },
          { name: "mem_text_get", policy: "auto" },
        ],
      }),
    });
    expect(result.ok).toBe(true);
    const warnings = await lintRegistry(result.snapshot!, { secrets: new SecretStore(root) });
    const memWarn = warnings.filter((w) => w.message.includes("generic memory write"));
    expect(memWarn).toHaveLength(1);
    expect(memWarn[0]!.message).toContain("mem_text_set");
    expect(memWarn[0]!.severity).toBe("warning");
  });
});

describe("lintRegistry — env declarations", () => {
  it("warns when a declared env key is absent from the .env chain and process.env", async () => {
    const { root, result } = await compile({
      "worker/agent.md": agentMd("Worker", { role: "worker" }),
      "worker/tools.json": toolsJson({ tools: [], env: ["DEFINITELY_MISSING_KEY_XYZ"] }),
    });
    const warnings = await lintRegistry(result.snapshot!, { secrets: new SecretStore(root) });
    expect(warnings.some((w) => w.message.includes("DEFINITELY_MISSING_KEY_XYZ"))).toBe(true);
  });

  it("warns when a ${KEY} in an http header is used but not declared", async () => {
    const { root, result } = await compile({
      "worker/agent.md": agentMd("Worker", { role: "worker" }),
      "worker/tools.json": toolsJson({
        tools: [],
        mcpServers: { svc: { type: "http", url: "https://x.example/mcp", headers: { Authorization: "Bearer ${UNDECLARED_KEY}" } } },
      }),
    });
    const warnings = await lintRegistry(result.snapshot!, { secrets: new SecretStore(root) });
    expect(warnings.some((w) => w.message.includes("UNDECLARED_KEY") && w.message.includes("not declared"))).toBe(true);
  });

  it("is silent when the declared key resolves from the .env chain", async () => {
    const { root, result } = await compile({
      "worker/agent.md": agentMd("Worker", { role: "worker" }),
      "worker/tools.json": toolsJson({ tools: [], env: ["PRESENT_KEY"] }),
    });
    await writeFiles(root, { "worker/.env": "PRESENT_KEY=value\n" });
    const warnings = await lintRegistry(result.snapshot!, { secrets: new SecretStore(root) });
    expect(warnings.some((w) => w.message.includes("PRESENT_KEY"))).toBe(false);
  });
});

describe("lintRegistry — unknown tool grants (serve-only)", () => {
  it("warns on a dead grant when plugin tool names are provided and no mcpServers declared", async () => {
    const { result } = await compile({
      "worker/agent.md": agentMd("Worker", { role: "worker" }),
      "worker/tools.json": toolsJson({ tools: [{ name: "totally_made_up_tool", policy: "auto" }] }),
    });
    const warnings = await lintRegistry(result.snapshot!, { pluginToolNamesByNode: () => [] });
    expect(warnings.some((w) => w.message.includes("totally_made_up_tool") && w.message.includes("no known tool"))).toBe(true);
  });

  it("does NOT run the unknown-tool check without plugin context (validate-time)", async () => {
    const { root, result } = await compile({
      "worker/agent.md": agentMd("Worker", { role: "worker" }),
      "worker/tools.json": toolsJson({ tools: [{ name: "totally_made_up_tool", policy: "auto" }] }),
    });
    const warnings = await lintRegistry(result.snapshot!, { secrets: new SecretStore(root) });
    expect(warnings.some((w) => w.message.includes("no known tool"))).toBe(false);
  });

  it("suppresses the unknown-tool warning when the node declares an mcpServer (could be a remote tool)", async () => {
    const { result } = await compile({
      "worker/agent.md": agentMd("Worker", { role: "worker" }),
      "worker/tools.json": toolsJson({
        tools: [{ name: "some_remote_tool", policy: "auto" }],
        mcpServers: { svc: { type: "http", url: "https://x.example/mcp" } },
      }),
    });
    const warnings = await lintRegistry(result.snapshot!, { pluginToolNamesByNode: () => [] });
    expect(warnings.some((w) => w.message.includes("some_remote_tool"))).toBe(false);
  });

  it("does not warn on a known catalog tool", async () => {
    const { result } = await compile({
      "worker/agent.md": agentMd("Worker", { role: "worker" }),
      "worker/tools.json": toolsJson({ tools: [{ name: "Read", policy: "auto" }, { name: "send_email", policy: "ask" }] }),
    });
    const warnings = await lintRegistry(result.snapshot!, { pluginToolNamesByNode: () => [] });
    expect(warnings.some((w) => w.message.includes("no known tool"))).toBe(false);
  });
});

describe("Diagnostic severity", () => {
  it("compile still fails on a real error (no severity field = error)", async () => {
    const { result } = await compile({
      "processes/bad.process.md": "---\nname: Bad\nowner: nonexistent-role\ndefinitionOfDone: x\n---\nbody",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("manifest (ravel.json) + runtimeVersion", () => {
  it("compiles clean with no manifest", async () => {
    const { result } = await compile({});
    expect(result.ok).toBe(true);
    expect(result.snapshot!.manifest).toBeUndefined();
  });

  it("attaches a valid manifest to the snapshot", async () => {
    const { result } = await compile({
      "ravel.json": JSON.stringify({ name: "t", runtimeVersion: "^0.2" }),
    });
    expect(result.ok).toBe(true);
    expect(result.snapshot!.manifest?.runtimeVersion).toBe("^0.2");
  });

  it("errors (not warns) on a malformed manifest", async () => {
    const { result } = await compile({ "ravel.json": "{ not valid json" });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.where === "ravel.json")).toBe(true);
  });

  it("warns when installed runtime doesn't satisfy the pinned range", async () => {
    const { result } = await compile({ "ravel.json": JSON.stringify({ runtimeVersion: "^0.9" }) });
    const warnings = await lintRegistry(result.snapshot!, { installedVersion: "0.2.0" });
    expect(warnings.some((w) => w.where === "ravel.json" && w.message.includes("runtimeVersion"))).toBe(true);
  });

  it("is silent when the installed runtime satisfies the pinned range", async () => {
    const { result } = await compile({ "ravel.json": JSON.stringify({ runtimeVersion: "^0.2" }) });
    const warnings = await lintRegistry(result.snapshot!, { installedVersion: "0.2.5" });
    expect(warnings.some((w) => w.where === "ravel.json")).toBe(false);
  });
});

describe("satisfiesRange", () => {
  it("caret on 0.x is minor-locked", () => {
    expect(satisfiesRange("0.2.0", "^0.2")).toBe(true);
    expect(satisfiesRange("0.2.9", "^0.2.1")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2")).toBe(false);
    expect(satisfiesRange("0.2.0", "^0.2.5")).toBe(false); // patch below floor
  });
  it("caret on >=1.x allows minor/patch within the major", () => {
    expect(satisfiesRange("1.4.0", "^1.2")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.2")).toBe(false);
  });
  it("tilde and exact", () => {
    expect(satisfiesRange("0.2.3", "~0.2.1")).toBe(true);
    expect(satisfiesRange("0.3.0", "~0.2.1")).toBe(false);
    expect(satisfiesRange("0.2.0", "0.2.0")).toBe(true);
    expect(satisfiesRange("0.2.1", "0.2.0")).toBe(false);
  });
});
