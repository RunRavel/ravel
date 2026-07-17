import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { App } from "../src/platform/app.js";
import { FakeEngine } from "../src/runtime/fakeEngine.js";
import { InMemoryAudit, JsonlAudit } from "../src/trust/audit.js";
import { EmittingAudit } from "../src/trust/emittingAudit.js";
import { createServer } from "../src/service/server.js";

const ACME = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "acme");

let apps: App[] = [];
let servers: Server[] = [];
let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  await Promise.all(apps.map((a) => a.stop()));
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  apps = [];
  servers = [];
  dirs = [];
});

/**
 * A disposable copy of the ACME fixture. Some tests write config through the
 * HTTP API (`PUT /api/files`), which writes real files under `root` — that
 * must never be the checked-in `examples/acme` on disk.
 */
async function copyAcme(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-acme-copy-"));
  dirs.push(dir);
  await fs.cp(ACME, dir, { recursive: true });
  return dir;
}

async function boot(
  engine: FakeEngine,
  opts: { uiDir?: string; readOnlyConfig?: boolean; root?: string } = {},
): Promise<string> {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-svc-"));
  dirs.push(runtimeDir);
  const events = new EmittingAudit(new InMemoryAudit());
  const app = new App({ root: opts.root ?? ACME, engine, audit: events, runtimeDir, watchOptions: { usePolling: true, interval: 50 } });
  apps.push(app);
  await app.start();
  const server = createServer({
    app,
    events,
    ...(opts.uiDir !== undefined ? { uiDir: opts.uiDir } : {}),
    ...(opts.readOnlyConfig ? { readOnlyConfig: true } : {}),
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  return `http://localhost:${port}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Boot with a durable JSONL audit on a fixed runtimeDir, so a restart can rehydrate it. */
async function bootDurable(runtimeDir: string, engine: FakeEngine): Promise<{ base: string; app: App; server: Server }> {
  const events = new EmittingAudit(new JsonlAudit(path.join(runtimeDir, "audit.jsonl")));
  const app = new App({ root: ACME, engine, audit: events, runtimeDir, watchOptions: { usePolling: true, interval: 50 } });
  await app.start();
  const server = createServer({ app, events });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://localhost:${port}`, app, server };
}

describe("HTTP service", () => {
  it("serves org/dashboard, runs a process in the background, and resolves a proposal", async () => {
    const engine = new FakeEngine(() => "ok", [
      () => JSON.stringify({ done: false, tasks: [{ assigneeRole: "copywriter", goal: "draft+send", definitionOfDone: "queued" }] }),
      async (ctx) => {
        const d = await ctx.useTool("send_email", { to: "vp@globex.com" });
        return d === "allow" ? "sent" : "send queued for approval";
      },
      () => JSON.stringify({ done: true, summary: "done" }),
    ]);
    const base = await boot(engine);

    // Read-only endpoints
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
    const org = (await (await fetch(`${base}/api/org`)).json()) as { nodes: Array<{ id: string }> };
    expect(org.nodes.map((n) => n.id)).toContain("growth/copywriter");
    const procs = (await (await fetch(`${base}/api/processes`)).json()) as { processes: Array<{ name: string }> };
    expect(procs.processes.map((p) => p.name)).toContain("Prospect Outreach");

    // Launch a run in the background → 202 {runId}
    const started = await fetch(`${base}/api/processes/${encodeURIComponent("Prospect Outreach")}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(started.status).toBe(202);
    const { runId } = (await started.json()) as { runId: string };
    expect(runId).toMatch(/^run_/);

    // Poll until the run completes
    let status = "running";
    for (let i = 0; i < 50 && status === "running"; i++) {
      await sleep(20);
      const rec = (await (await fetch(`${base}/api/runs/${runId}`)).json()) as { status: string };
      status = rec.status;
    }
    expect(status).toBe("completed");

    // A proposal was queued for the deferred send
    const pending = (await (await fetch(`${base}/api/proposals?status=pending`)).json()) as {
      proposals: Array<{ id: string; action: string }>;
    };
    expect(pending.proposals).toHaveLength(1);
    expect(pending.proposals[0]!.action).toBe("send_email");

    // Approve it → executor runs
    const resolved = await fetch(`${base}/api/proposals/${pending.proposals[0]!.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(((await resolved.json()) as { proposal: { status: string } }).proposal.status).toBe("executed");

    const dash = (await (await fetch(`${base}/api/dashboard`)).json()) as { pendingProposals: number };
    expect(dash.pendingProposals).toBe(0);

    // The run is listed in history (survives navigation/remount in the UI).
    const list = (await (await fetch(`${base}/api/runs`)).json()) as { runs: Array<{ runId: string; process: string; status: string }> };
    expect(list.runs.some((r) => r.runId === runId && r.process === "Prospect Outreach" && r.status === "completed")).toBe(true);
  });

  it("streams audit events over SSE (so the Activity feed populates)", async () => {
    const engine = new FakeEngine(() => "ok", [() => JSON.stringify({ done: true, summary: "nothing to do" })]);
    const base = await boot(engine);

    // Produce some audit events.
    const { runId } = (await (
      await fetch(`${base}/api/processes/${encodeURIComponent("Prospect Outreach")}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { runId: string };
    for (let i = 0; i < 50; i++) {
      const r = (await (await fetch(`${base}/api/runs/${runId}`)).json()) as { status: string };
      if (r.status !== "running") break;
      await sleep(20);
    }

    // Connect SSE and read the backfill (what a freshly-opened console receives).
    const res = await fetch(`${base}/api/events`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (let i = 0; i < 20 && !text.includes("process.started"); i++) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array }>((r) => setTimeout(() => r({}), 100)),
      ]);
      if (chunk.value) text += dec.decode(chunk.value);
    }
    await reader.cancel();

    expect(text).toContain("event: audit");
    expect(text).toContain("process.started");
  });

  it("reconstructs chat history from the audit trail", async () => {
    const base = await boot(new FakeEngine(() => "Hello back."));
    await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "growth", message: "Hi there" }),
    });
    const hist = (await (await fetch(`${base}/api/chats?nodeId=growth`)).json()) as {
      turns: Array<{ who: string; text: string }>;
    };
    expect(hist.turns).toEqual([
      { who: "me", text: "Hi there", at: expect.any(String) },
      { who: "agent", text: "Hello back.", at: expect.any(String) },
    ]);
  });

  it("runs and chats survive a server restart (audit rehydrated from disk)", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-restart-"));
    dirs.push(runtimeDir);

    // --- Session 1: run a process and have a chat, then "shut down". ---
    const engine1 = new FakeEngine(() => "Ack.", [
      () => JSON.stringify({ done: false, tasks: [{ assigneeRole: "researcher", goal: "research", definitionOfDone: "done" }] }),
      () => "Researched.",
      () => JSON.stringify({ done: true, summary: "done" }),
    ]);
    const s1 = await bootDurable(runtimeDir, engine1);
    const { runId } = (await (
      await fetch(`${s1.base}/api/processes/${encodeURIComponent("Prospect Outreach")}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json()) as { runId: string };
    for (let i = 0; i < 50; i++) {
      const rec = (await (await fetch(`${s1.base}/api/runs/${runId}`)).json()) as { status: string };
      if (rec.status !== "running") break;
      await sleep(20);
    }
    await fetch(`${s1.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "growth", message: "hello" }),
    });
    await new Promise<void>((r) => s1.server.close(() => r()));
    await s1.app.stop();

    // --- Session 2: fresh App + server on the SAME runtimeDir. ---
    const s2 = await bootDurable(runtimeDir, new FakeEngine(() => "ok"));
    try {
      const runs = (await (await fetch(`${s2.base}/api/runs`)).json()) as { runs: Array<{ runId: string; status: string }> };
      expect(runs.runs.some((r) => r.runId === runId && r.status === "completed")).toBe(true);

      const hist = (await (await fetch(`${s2.base}/api/chats?nodeId=growth`)).json()) as { turns: Array<{ text: string }> };
      expect(hist.turns.map((t) => t.text)).toContain("hello");
    } finally {
      await new Promise<void>((r) => s2.server.close(() => r()));
      await s2.app.stop();
    }
  });

  it("marks crash-interrupted runs as interrupted and lets them be dismissed", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-stale-"));
    dirs.push(runtimeDir);
    // Simulate a prior process that started a run but never wrote process.finished.
    const started = {
      seq: 1,
      at: "2026-01-01T00:00:00.000Z",
      type: "process.started",
      runId: "run_stale",
      data: { process: "Prospect Outreach", inputs: { sourceLang: "en" } },
    };
    await fs.writeFile(path.join(runtimeDir, "audit.jsonl"), JSON.stringify(started) + "\n", "utf8");

    const s = await bootDurable(runtimeDir, new FakeEngine(() => "ok"));
    try {
      let runs = (await (await fetch(`${s.base}/api/runs`)).json()) as { runs: Array<{ runId: string; status: string; inputs?: Record<string, unknown> }> };
      const stale = runs.runs.find((r) => r.runId === "run_stale");
      expect(stale?.status).toBe("interrupted"); // not falsely "running"
      expect(stale?.inputs).toEqual({ sourceLang: "en" }); // inputs preserved for re-run prefill

      await fetch(`${s.base}/api/runs/run_stale/dismiss`, { method: "POST" });
      runs = (await (await fetch(`${s.base}/api/runs`)).json()) as typeof runs;
      expect(runs.runs.some((r) => r.runId === "run_stale")).toBe(false);
    } finally {
      await new Promise<void>((r) => s.server.close(() => r()));
      await s.app.stop();
    }
  });

  it("serves the built operator console from the same port when uiDir is set", async () => {
    const uiDir = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-ui-"));
    dirs.push(uiDir);
    await fs.mkdir(path.join(uiDir, "assets"), { recursive: true });
    await fs.writeFile(path.join(uiDir, "index.html"), "<!doctype html><title>console shell</title>", "utf8");
    await fs.writeFile(path.join(uiDir, "assets", "app.js"), "console.log(1)", "utf8");
    const base = await boot(new FakeEngine(() => "ok"), { uiDir });

    // The shell and its assets, with correct content types.
    const home = await fetch(`${base}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    expect(await home.text()).toContain("console shell");
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    // Extensionless miss = client-side route → shell; missing asset = real 404.
    expect(await (await fetch(`${base}/some/route`)).text()).toContain("console shell");
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);

    // API routes still win over static serving.
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
  });

  it("grants CORS only to loopback origins (auth-free API must not be browser-drivable cross-site)", async () => {
    const base = await boot(new FakeEngine(() => "ok"));

    const local = await fetch(`${base}/api/health`, { headers: { Origin: "http://localhost:5173" } });
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const remote = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
    expect(remote.headers.get("access-control-allow-origin")).toBeNull();

    const none = await fetch(`${base}/api/health`);
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("blocks config and secret writes in read-only-config mode (scheduler stays writable)", async () => {
    const base = await boot(new FakeEngine(() => "ok"), { readOnlyConfig: true });

    const putFile = await fetch(`${base}/api/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "growth/agent.md", content: "x" }),
    });
    expect(putFile.status).toBe(403);

    const putSecret = await fetch(`${base}/api/secrets`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "growth", key: "SOME_KEY", value: "v" }),
    });
    expect(putSecret.status).toBe(403);

    // Scheduler config is team state, not config — stays writable.
    const putSched = await fetch(`${base}/api/scheduler`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Prospect Outreach", enabled: false }),
    });
    expect(putSched.status).toBe(200);

    // Reads are unaffected.
    expect((await fetch(`${base}/api/files?path=${encodeURIComponent("growth/agent.md")}`)).status).toBe(200);
  });

  it("returns 404 (not the shell) for non-API paths when no uiDir is set", async () => {
    const base = await boot(new FakeEngine(() => "ok"));
    expect((await fetch(`${base}/`)).status).toBe(404);
  });

  it("validates config edits and guards path traversal", async () => {
    const base = await boot(new FakeEngine(() => "ok"));

    // Valid read of an existing authoring file
    const read = (await (await fetch(`${base}/api/files?path=${encodeURIComponent("growth/agent.md")}`)).json()) as {
      content?: string;
    };
    expect(read.content).toContain("Growth Manager");

    // Traversal is rejected
    const escape = await fetch(`${base}/api/files?path=${encodeURIComponent("../../etc/hosts")}`);
    expect(escape.status).toBe(400);

    // Writing a non-authoring file is rejected
    const badPut = await fetch(`${base}/api/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "secrets.txt", content: "x" }),
    });
    expect(badPut.status).toBe(400);

    // validate returns diagnostics shape
    const v = (await (await fetch(`${base}/api/validate`)).json()) as { ok: boolean };
    expect(v.ok).toBe(true);
  });

  it("/api/validate and PUT /api/files surface lint warnings (severity + code), not just compile errors", async () => {
    // Isolated copy — this test PUTs config through the API, which writes real
    // files under root; must never touch the checked-in examples/acme fixture.
    const base = await boot(new FakeEngine(() => "ok"), { root: await copyAcme() });

    // The acme fixture has no generic memory-write grants — clean.
    const clean = (await (await fetch(`${base}/api/validate`)).json()) as { ok: boolean; diagnostics: Array<{ code?: string }> };
    expect(clean.ok).toBe(true);
    expect(clean.diagnostics.some((d) => d.code === "memory-write")).toBe(false);

    // Grant a generic memory write — both /api/validate and the PUT response should warn.
    const toolsJson = JSON.stringify({ tools: [{ name: "mem_text_set", policy: "auto" }] });
    const put = await fetch(`${base}/api/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "growth/copywriter/tools.json", content: toolsJson }),
    });
    const putBody = (await put.json()) as { ok: boolean; diagnostics: Array<{ code?: string; severity?: string; where: string }> };
    expect(putBody.ok).toBe(true); // warnings never fail compile
    const warning = putBody.diagnostics.find((d) => d.code === "memory-write");
    expect(warning?.severity).toBe("warning");
    expect(warning?.where).toBe("growth/copywriter/tools.json");

    const after = (await (await fetch(`${base}/api/validate`)).json()) as { diagnostics: Array<{ code?: string }> };
    expect(after.diagnostics.some((d) => d.code === "memory-write")).toBe(true);
  });
});
