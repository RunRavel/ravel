import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { App } from "../src/platform/app.js";
import { FakeEngine } from "../src/runtime/fakeEngine.js";
import { InMemoryAudit } from "../src/trust/audit.js";
import { makeTempOrg, cleanup, agentMd } from "./helpers/tempOrg.js";

let roots: string[] = [];
let apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.stop()));
  await Promise.all(roots.map((r) => cleanup(r)));
  apps = [];
  roots = [];
});

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

async function bootOrg(seed: Record<string, string>, runtimeDir?: string) {
  const root = await makeTempOrg({ "agent.md": agentMd("Lead"), ...seed });
  roots.push(root);
  const audit = new InMemoryAudit();
  const app = new App({
    root,
    engine: new FakeEngine(() => "ok"),
    audit,
    ...(runtimeDir ? { runtimeDir: path.join(root, runtimeDir) } : {}),
    watchOptions: { usePolling: true, interval: 50 },
  });
  apps.push(app);
  await app.start();
  return { root, app, audit };
}

describe("legacy state-dir migration (.businessos → .ravel)", () => {
  it("renames .businessos to .ravel at the default location and audits it", async () => {
    const { root, audit } = await bootOrg({ ".businessos/memory/org/note.md": "hello" });
    expect(await exists(path.join(root, ".ravel", "memory", "org", "note.md"))).toBe(true);
    expect(await exists(path.join(root, ".businessos"))).toBe(false);
    expect(audit.all().some((e) => e.type === "state.migrated")).toBe(true);
  });

  it("leaves .businessos alone when a custom runtimeDir is used", async () => {
    const { root, audit } = await bootOrg({ ".businessos/memory/org/note.md": "hello" }, "custom-state");
    expect(await exists(path.join(root, ".businessos"))).toBe(true);
    expect(await exists(path.join(root, ".ravel"))).toBe(false);
    expect(audit.all().some((e) => e.type === "state.migrated")).toBe(false);
  });

  it("does not touch anything when .ravel already exists", async () => {
    const { root, audit } = await bootOrg({
      ".businessos/old.txt": "old",
      ".ravel/new.txt": "new",
    });
    expect(await exists(path.join(root, ".businessos", "old.txt"))).toBe(true);
    expect(await exists(path.join(root, ".ravel", "new.txt"))).toBe(true);
    expect(audit.all().some((e) => e.type === "state.migrated")).toBe(false);
  });
});
