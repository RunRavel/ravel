import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { RegistryWatcher } from "../src/control-plane/watcher.js";
import type { RegistrySnapshot, Diagnostic } from "../src/control-plane/registry.js";
import { makeTempOrg, cleanup, writeFiles, agentMd } from "./helpers/tempOrg.js";

let roots: string[] = [];
let watchers: RegistryWatcher[] = [];
afterEach(async () => {
  await Promise.all(watchers.map((w) => w.stop()));
  await Promise.all(roots.map(cleanup));
  roots = [];
  watchers = [];
});

/** Resolve on the next snapshot or invalid event from the watcher. */
function nextEvent(
  w: RegistryWatcher,
): Promise<{ kind: "snapshot"; snapshot: RegistrySnapshot } | { kind: "invalid"; diagnostics: Diagnostic[] }> {
  return new Promise((resolve) => {
    const onSnap = (snapshot: RegistrySnapshot) => {
      w.off("invalid", onInvalid);
      resolve({ kind: "snapshot", snapshot });
    };
    const onInvalid = (diagnostics: Diagnostic[]) => {
      w.off("snapshot", onSnap);
      resolve({ kind: "invalid", diagnostics });
    };
    w.once("snapshot", onSnap);
    w.once("invalid", onInvalid);
  });
}

/** True if NO snapshot/invalid event fires within `ms` (i.e. no recompile). */
function noEventWithin(w: RegistryWatcher, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const fired = () => {
      clear();
      resolve(false);
    };
    const t = setTimeout(() => {
      clear();
      resolve(true);
    }, ms);
    const clear = () => {
      clearTimeout(t);
      w.off("snapshot", fired);
      w.off("invalid", fired);
    };
    w.on("snapshot", fired);
    w.on("invalid", fired);
  });
}

describe("RegistryWatcher", () => {
  it("recompiles and bumps version when a child agent is added", async () => {
    const root = await makeTempOrg({ "agent.md": agentMd("CEO", { role: "ceo" }) });
    roots.push(root);
    const w = new RegistryWatcher(root, {
      debounceMs: 30,
      watchOptions: { usePolling: true, interval: 25, awaitWriteFinish: false },
    });
    watchers.push(w);

    const initial = await w.start();
    expect(initial.ok).toBe(true);
    expect(initial.snapshot!.version).toBe(1);
    expect(initial.snapshot!.nodes.size).toBe(1);

    const evt = nextEvent(w);
    await writeFiles(root, { "ops/agent.md": agentMd("Ops", { role: "ops" }) });
    const result = await evt;

    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect(result.snapshot.version).toBe(2);
    expect(result.snapshot.nodes.size).toBe(2);
    expect(result.snapshot.nodes.has("ops")).toBe(true);
  });

  it("keeps the last-good snapshot when an edit makes the tree invalid", async () => {
    const root = await makeTempOrg({ "agent.md": agentMd("CEO", { role: "ceo" }) });
    roots.push(root);
    const w = new RegistryWatcher(root, {
      debounceMs: 30,
      watchOptions: { usePolling: true, interval: 25, awaitWriteFinish: false },
    });
    watchers.push(w);
    await w.start();
    const good = w.current()!;
    expect(good.version).toBe(1);

    const evt = nextEvent(w);
    // Break the root agent.md (empty body).
    await fs.writeFile(path.join(root, "agent.md"), "---\nname: CEO\n---\n", "utf8");
    const result = await evt;

    expect(result.kind).toBe("invalid");
    // Last-good is retained and unchanged.
    expect(w.current()).toBe(good);
    expect(w.current()!.version).toBe(1);
  });

  it("ignores writes inside the runtime/state dir (memory writes are not config edits)", async () => {
    const root = await makeTempOrg({ "agent.md": agentMd("CEO", { role: "ceo" }) });
    roots.push(root);
    const w = new RegistryWatcher(root, {
      debounceMs: 30,
      runtimeDir: path.join(root, ".ravel"), // default location: inside the watched root
      watchOptions: { usePolling: true, interval: 25, awaitWriteFinish: false },
    });
    watchers.push(w);
    await w.start();
    expect(w.current()!.version).toBe(1);

    // A memory/audit-style write under the runtime dir must NOT recompile.
    await writeFiles(root, { ".ravel/memory/team/ceo/notes.md": "hello" });
    expect(await noEventWithin(w, 400)).toBe(true);
    expect(w.current()!.version).toBe(1);

    // ...but a real config edit still does (proves the watcher is live, not stalled).
    const evt = nextEvent(w);
    await writeFiles(root, { "ops/agent.md": agentMd("Ops", { role: "ops" }) });
    const result = await evt;
    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect(result.snapshot.version).toBe(2);
    expect(result.snapshot.nodes.has("ops")).toBe(true);
  });

  it("ignores an explicit --state-dir that points inside the org root", async () => {
    const root = await makeTempOrg({ "agent.md": agentMd("CEO", { role: "ceo" }) });
    roots.push(root);
    const w = new RegistryWatcher(root, {
      debounceMs: 30,
      runtimeDir: path.join(root, "state"), // custom name, still inside root
      watchOptions: { usePolling: true, interval: 25, awaitWriteFinish: false },
    });
    watchers.push(w);
    await w.start();

    await writeFiles(root, { "state/audit.jsonl": '{"seq":1}\n' });
    expect(await noEventWithin(w, 400)).toBe(true);
    expect(w.current()!.version).toBe(1);
  });

  it("does not follow a symlink out of the repo to an external state dir", async () => {
    const root = await makeTempOrg({ "agent.md": agentMd("CEO", { role: "ceo" }) });
    roots.push(root);
    // An external dir (as a hosted --state-dir would be), plus a symlink to it
    // inside the watched checkout.
    const external = await makeTempOrg({ "seed.txt": "x" });
    roots.push(external);
    await fs.symlink(external, path.join(root, "state-link"), "dir").catch(() => {
      /* symlink perms vary; the assertion below still holds if it no-ops */
    });
    const w = new RegistryWatcher(root, {
      debounceMs: 30,
      watchOptions: { usePolling: true, interval: 25, awaitWriteFinish: false },
    });
    watchers.push(w);
    await w.start();

    // Changing a file in the external target must not reach the config watcher.
    await writeFiles(external, { "changed.txt": "y" });
    expect(await noEventWithin(w, 400)).toBe(true);
    expect(w.current()!.version).toBe(1);
  });

  it("reflects a removed agent folder in the next snapshot", async () => {
    const root = await makeTempOrg({
      "agent.md": agentMd("CEO", { role: "ceo" }),
      "ops/agent.md": agentMd("Ops", { role: "ops" }),
    });
    roots.push(root);
    const w = new RegistryWatcher(root, {
      debounceMs: 30,
      watchOptions: { usePolling: true, interval: 25, awaitWriteFinish: false },
    });
    watchers.push(w);
    const initial = await w.start();
    expect(initial.snapshot!.nodes.size).toBe(2);

    const evt = nextEvent(w);
    await fs.rm(path.join(root, "ops"), { recursive: true, force: true });
    const result = await evt;

    expect(result.kind).toBe("snapshot");
    if (result.kind !== "snapshot") return;
    expect(result.snapshot.nodes.has("ops")).toBe(false);
    expect(result.snapshot.nodes.size).toBe(1);
  });
});
