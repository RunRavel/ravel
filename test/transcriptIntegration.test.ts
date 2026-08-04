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

async function boot(engine: FakeEngine, opts: { captureTranscripts?: boolean } = {}): Promise<{ base: string; runtimeDir: string }> {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-transcript-svc-"));
  dirs.push(runtimeDir);
  const events = new EmittingAudit(new InMemoryAudit());
  const app = new App({
    root: ACME,
    engine,
    audit: events,
    runtimeDir,
    ...(opts.captureTranscripts ? { captureTranscripts: true } : {}),
    watchOptions: { usePolling: true, interval: 50 },
  });
  apps.push(app);
  await app.start();
  const server = createServer({ app, events });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, runtimeDir };
}

/** Scripted run: growth dispatches researcher, researcher works (emitting mid-turn text), growth declares done. */
function scriptedEngine(): FakeEngine {
  return new FakeEngine(() => "ok", [
    () =>
      JSON.stringify({
        done: false,
        tasks: [{ assigneeRole: "researcher", goal: "Research prospect Globex", definitionOfDone: "A brief exists" }],
      }),
    (ctx) => {
      ctx.emitTranscriptText("Let me check what Globex does before writing anything.");
      ctx.emitTranscriptText("Brief: Globex makes logistics software.");
      return "Brief: Globex makes logistics software.";
    },
    () => JSON.stringify({ done: true, summary: "Research brief produced for Globex." }),
  ]);
}

describe("GET /api/runs/:id/transcript — opt-in capture (WO-021 / ask #25)", () => {
  it("with captureTranscripts on: a multi-turn run's transcript includes text from turns other than the last", async () => {
    const { base } = await boot(scriptedEngine(), { captureTranscripts: true });
    const appUnderTest = apps[apps.length - 1]!;
    const result = await appUnderTest.runProcess("Prospect Outreach");

    const body = (await (await fetch(`${base}/api/runs/${result.runId}/transcript`)).json()) as {
      transcript: Array<{ nodeId: string; contractId?: string; text: string }>;
    };
    const texts = body.transcript.map((e) => e.text);
    expect(texts).toContain("Let me check what Globex does before writing anything.");
    expect(texts).toContain("Brief: Globex makes logistics software.");
    // Attributed to the worker that produced it, with its contractId.
    const midTurn = body.transcript.find((e) => e.text.includes("check what Globex"))!;
    expect(midTurn.nodeId).toBe("growth/researcher");
    expect(midTurn.contractId).toBeDefined();
  });

  it("with captureTranscripts off (default): no transcript, no file, identical run behavior", async () => {
    const { base, runtimeDir } = await boot(scriptedEngine());
    const appUnderTest = apps[apps.length - 1]!;
    const result = await appUnderTest.runProcess("Prospect Outreach");
    expect(result.status).toBe("completed");

    const body = (await (await fetch(`${base}/api/runs/${result.runId}/transcript`)).json()) as { transcript: unknown[] };
    expect(body.transcript).toEqual([]);

    const exists = await fs
      .access(path.join(runtimeDir, "runs", result.runId, "transcript.jsonl"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("a nonexistent run id degrades cleanly — [] over the endpoint, not an error", async () => {
    const { base } = await boot(scriptedEngine(), { captureTranscripts: true });
    const res = await fetch(`${base}/api/runs/no-such-run/transcript`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transcript: unknown[] };
    expect(body.transcript).toEqual([]);
  });
});

describe("process.finished records the run's own final summary (WO-021 part 3)", () => {
  it("carries the same summary text ProcessRunResult returns", async () => {
    const { } = await boot(scriptedEngine());
    const appUnderTest = apps[apps.length - 1]!;
    const result = await appUnderTest.runProcess("Prospect Outreach");
    const finished = appUnderTest.audit.all().find((e) => e.type === "process.finished" && e.runId === result.runId)!;
    expect(finished.data["summary"]).toBe(result.summary);
    expect(result.summary).toBe("Research brief produced for Globex.");
  });
});
