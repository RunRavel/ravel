import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { App } from "../src/platform/app.js";
import { FakeEngine } from "../src/runtime/fakeEngine.js";
import { InMemoryAudit } from "../src/trust/audit.js";
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

async function boot(engine: FakeEngine, opts: { readOnlyConfig?: boolean } = {}): Promise<string> {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-limits-svc-"));
  dirs.push(runtimeDir);
  const events = new EmittingAudit(new InMemoryAudit());
  const app = new App({ root: ACME, engine, audit: events, runtimeDir, watchOptions: { usePolling: true, interval: 50 } });
  apps.push(app);
  await app.start();
  const server = createServer({ app, events, ...(opts.readOnlyConfig ? { readOnlyConfig: true } : {}) });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("GET /api/processes — ask #18 (expose ProcessSpec.budget)", () => {
  it("includes budget, participants, and approvals for a process that declares them", async () => {
    const base = await boot(new FakeEngine(() => "ok"));
    const body = (await (await fetch(`${base}/api/processes`)).json()) as {
      processes: Array<{ name: string; budget?: { usd?: number; turns?: number }; participants: string[]; approvals: string[] }>;
    };
    const proc = body.processes.find((p) => p.name === "Prospect Outreach")!;
    expect(proc.budget).toEqual({ tokens: 300000, usd: 5, turns: 6 });
    expect(proc.participants).toEqual(["researcher", "copywriter"]);
    expect(proc.approvals).toEqual(["send_email"]);
  });
});

describe("GET/PUT/DELETE /api/limits — ask #23", () => {
  it("returns { document: null } when no limits document is set", async () => {
    const base = await boot(new FakeEngine(() => "ok"));
    const body = (await (await fetch(`${base}/api/limits`)).json()) as { document: unknown };
    expect(body.document).toBeNull();
  });

  it("PUT validates and persists; GET reflects it; DELETE clears it", async () => {
    const base = await boot(new FakeEngine(() => "ok"));
    const doc = { default: [{ scope: { type: "per-run" }, amountUsd: 1, action: "stop" }] };
    const put = await fetch(`${base}/api/limits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    expect(put.status).toBe(200);

    const got = (await (await fetch(`${base}/api/limits`)).json()) as { document: { default: unknown[] } };
    expect(got.document.default).toHaveLength(1);

    const del = await fetch(`${base}/api/limits`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = (await (await fetch(`${base}/api/limits`)).json()) as { document: unknown };
    expect(after.document).toBeNull();
  });

  it("rejects a per-run entry with action 'warn' — 400, not a silent downgrade", async () => {
    const base = await boot(new FakeEngine(() => "ok"));
    const put = await fetch(`${base}/api/limits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default: [{ scope: { type: "per-run" }, amountUsd: 1, action: "warn" }] }),
    });
    expect(put.status).toBe(400);
  });

  it("writes stay enabled under --read-only-config (team state, not git-sourced config)", async () => {
    const base = await boot(new FakeEngine(() => "ok"), { readOnlyConfig: true });
    const put = await fetch(`${base}/api/limits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default: [{ scope: { type: "per-run" }, amountUsd: 1, action: "stop" }] }),
    });
    expect(put.status).toBe(200);
    // Contrast: /api/files IS blocked under read-only-config.
    const filesPut = await fetch(`${base}/api/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "growth/tools.json", content: "{}" }),
    });
    expect(filesPut.status).toBe(403);
  });

  it("survives a worker restart — persisted at <runtimeDir>/limits.json, reloaded by a fresh App", async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-limits-restart-"));
    dirs.push(runtimeDir);
    const events1 = new EmittingAudit(new InMemoryAudit());
    const app1 = new App({ root: ACME, engine: new FakeEngine(() => "ok"), audit: events1, runtimeDir, watchOptions: { usePolling: true, interval: 50 } });
    apps.push(app1);
    await app1.start();
    await app1.limits.set({ default: [{ scope: { type: "per-run" }, amountUsd: 3, action: "stop" }] });
    await app1.stop();

    // A brand-new App over the SAME runtimeDir — simulates a worker restart.
    const events2 = new EmittingAudit(new InMemoryAudit());
    const app2 = new App({ root: ACME, engine: new FakeEngine(() => "ok"), audit: events2, runtimeDir, watchOptions: { usePolling: true, interval: 50 } });
    apps.push(app2);
    await app2.start();
    expect(app2.limits.perRunBudget("Prospect Outreach")).toEqual({ usd: 3 });
  });
});

describe("App.runProcess — rolling-window pre-flight gate blocks before the orchestrator starts", () => {
  it("returns budget_exhausted without dispatching any task when a rolling 'stop' entry is already tripped", async () => {
    const base = await boot(new FakeEngine(() => "ok"));
    const appUnderTest = apps[apps.length - 1]!;
    // Prime the ledger with a prior run that already spent past the rolling cap.
    await appUnderTest.audit.append("process.started", { runId: "prior-run", data: { process: "Prospect Outreach" } });
    await appUnderTest.audit.append("process.finished", { runId: "prior-run", data: { process: "Prospect Outreach", usage: { usd: 999 } } });
    await appUnderTest.limits.set({
      default: [{ scope: { type: "rolling", seconds: 86400 }, amountUsd: 1, action: "stop" }],
    });

    const result = await appUnderTest.runProcess("Prospect Outreach");
    expect(result.status).toBe("budget_exhausted");
    expect(result.results).toEqual([]);
    expect(result.turns).toBe(0);
    expect(result.summary).toContain("Blocked before starting");
  });
});
