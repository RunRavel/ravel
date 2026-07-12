import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { SecretStore, parseDotEnv } from "../src/secrets/store.js";
import { assembleMcpServers } from "../src/runtime/sdkEngine.js";
import type { EngineRequest } from "../src/runtime/engine.js";
import type { ToolsConfig } from "../src/schemas/tools.js";

let root: string;
let store: SecretStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-secrets-"));
  store = new SecretStore(root);
  // org/  globex/  globex/data-reader/  globex/data-curator/
  await fs.mkdir(path.join(root, "globex", "data-reader"), { recursive: true });
  await fs.mkdir(path.join(root, "globex", "data-curator"), { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const write = (rel: string, body: string) => fs.writeFile(path.join(root, rel, ".env"), body, "utf8");

describe("parseDotEnv", () => {
  it("parses KEY=VALUE, skips comments/blanks, strips quotes", () => {
    expect(parseDotEnv('A=1\n# c\n\nB="two"\nC=\'three\'')).toEqual({ A: "1", B: "two", C: "three" });
  });
});

describe("SecretStore.resolve", () => {
  it("merges the chain root → team → agent (deepest wins)", async () => {
    await write(".", "SHARED=root\nSERVICE_KEY=should-be-overridden");
    await write("globex", "SERVICE_KEY=team-read");
    await write("globex/data-curator", "SERVICE_KEY=agent-write");

    const reader = await store.resolve(path.join(root, "globex", "data-reader"));
    const curator = await store.resolve(path.join(root, "globex", "data-curator"));

    expect(reader).toEqual({ SHARED: "root", SERVICE_KEY: "team-read" });
    expect(curator).toEqual({ SHARED: "root", SERVICE_KEY: "agent-write" });
  });

  it("isolates siblings — the reader never sees a curator-only key", async () => {
    await write("globex", "SERVICE_KEY=read");
    await write("globex/data-curator", "SERVICE_WRITE=secret-write");

    const reader = await store.resolve(path.join(root, "globex", "data-reader"));
    expect(reader["SERVICE_KEY"]).toBe("read");
    expect(reader["SERVICE_WRITE"]).toBeUndefined(); // curator-only, unreachable

    const curator = await store.resolve(path.join(root, "globex", "data-curator"));
    expect(curator["SERVICE_WRITE"]).toBe("secret-write");
  });

  it("returns {} for a dir outside the org root", async () => {
    expect(await store.resolve("/etc")).toEqual({});
  });
});

describe("SecretStore set/list/delete (own .env only)", () => {
  it("round-trips keys on the node's own .env and lists names", async () => {
    const dir = path.join(root, "globex", "data-curator");
    await store.setKey(dir, "SERVICE_KEY", "write-key");
    await store.setKey(dir, "OTHER", "x");
    expect((await store.listKeys(dir)).sort()).toEqual(["OTHER", "SERVICE_KEY"]);

    await store.deleteKey(dir, "OTHER");
    expect(await store.listKeys(dir)).toEqual(["SERVICE_KEY"]);

    // The value is on disk but listKeys never exposes it.
    const resolved = await store.resolve(dir);
    expect(resolved["SERVICE_KEY"]).toBe("write-key");
  });

  it("rejects an invalid key name", async () => {
    await expect(store.setKey(path.join(root, "globex"), "bad-key", "x")).rejects.toThrow();
  });
});

describe("assembleMcpServers — per-node credential injection", () => {
  function globexReq(nodeEnv: Record<string, string>): EngineRequest {
    const tools: ToolsConfig = {
      tools: [],
      mcpServers: { globex: { type: "http", url: "https://globex.example.com/mcp", headers: { Authorization: "Bearer ${SERVICE_KEY}" } } },
      defaultPolicy: "ask",
    };
    return {
      systemPrompt: "x",
      model: "claude-sonnet-4-6",
      prompt: "x",
      tools,
      builtinTools: [],
      cwd: "/tmp",
      signal: new AbortController().signal,
      decide: async () => "allow",
      nodeEnv,
    };
  }
  const auth = (servers: Record<string, unknown>) =>
    (servers["globex"] as { headers?: Record<string, string> }).headers?.["Authorization"];

  it("substitutes ${VAR} in external-MCP http headers from nodeEnv", () => {
    expect(auth(assembleMcpServers(globexReq({ SERVICE_KEY: "node-key" })))).toBe("Bearer node-key");
  });

  it("falls back to process.env when nodeEnv lacks the key", () => {
    process.env["TMP_SERVICE_KEY_TEST"] = "env-key";
    const tools: ToolsConfig = {
      tools: [],
      mcpServers: { globex: { type: "http", url: "https://globex.example.com/mcp", headers: { Authorization: "Bearer ${TMP_SERVICE_KEY_TEST}" } } },
      defaultPolicy: "ask",
    };
    const req = { ...globexReq({}), tools };
    expect(auth(assembleMcpServers(req))).toBe("Bearer env-key");
    delete process.env["TMP_SERVICE_KEY_TEST"];
  });
});
