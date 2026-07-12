import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { App } from "../src/platform/app.js";
import { FakeEngine } from "../src/runtime/fakeEngine.js";
import { InMemoryAudit } from "../src/trust/audit.js";
import { usageFor } from "../src/domain/pricing.js";

const ACME = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "acme");

let apps: App[] = [];
let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.stop()));
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  apps = [];
  dirs = [];
});

async function bootApp(engine: FakeEngine, opts: { dryRun?: boolean } = {}) {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-rt-"));
  dirs.push(runtimeDir);
  const audit = new InMemoryAudit();
  const app = new App({
    root: ACME,
    engine,
    audit,
    runtimeDir,
    ...(opts.dryRun ? { dryRun: true } : {}),
    // No watching needed for the test; compile once via start().
    watchOptions: { usePolling: true, interval: 50 },
  });
  apps.push(app);
  await app.start();
  return { app, audit };
}

describe("end-to-end: Prospect Outreach", () => {
  it("orchestrates research → draft → approval-gated send → roll-up, fully audited", async () => {
    // FIFO programs map to the deterministic call order:
    //  1) growth plans: dispatch researcher
    //  2) researcher works
    //  3) growth plans: dispatch copywriter
    //  4) copywriter drafts and attempts the gated send_email tool
    //  5) growth plans: done
    const engine = new FakeEngine(() => "ok", [
      () =>
        JSON.stringify({
          done: false,
          tasks: [
            {
              assigneeRole: "researcher",
              goal: "Research prospect Globex",
              definitionOfDone: "A concise brief exists",
            },
          ],
        }),
      (ctx) => {
        ctx.emitUsage(usageFor("claude-sonnet-4-6", 1200, 300));
        return "Brief: Globex makes logistics software; just raised a Series B; pain = manual fulfilment.";
      },
      () =>
        JSON.stringify({
          done: false,
          tasks: [
            {
              assigneeRole: "copywriter",
              goal: "Draft outreach email to Globex grounded in the brief",
              definitionOfDone: "A drafted email is queued for sending",
            },
          ],
        }),
      async (ctx) => {
        ctx.emitUsage(usageFor("claude-sonnet-4-6", 900, 250));
        // Deferred gate: the send is denied now and queued as a proposal.
        const decision = await ctx.useTool("send_email", { to: "vp@globex.com", subject: "Faster fulfilment" });
        return decision === "allow" ? "Email drafted and queued for send." : "Draft ready; send queued for approval.";
      },
      () => JSON.stringify({ done: true, summary: "Brief produced and outreach email queued pending approval." }),
    ]);

    const { app, audit } = await bootApp(engine); // default: deferred (async) approvals

    const result = await app.runProcess("Prospect Outreach");

    // The run completes WITHOUT blocking on a human; the send is deferred.
    expect(result.status).toBe("completed");
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.summary).toMatch(/Globex/);
    expect(result.results[1]!.status).toBe("deferred");
    expect(result.results[1]!.pendingProposalIds).toHaveLength(1);

    // A proposal is queued for the gated send.
    const pending = app.pendingProposals();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.action).toBe("send_email");

    // Audit shows the proposal was created (no blocking approval in deferred mode).
    const types = audit.all().map((e) => e.type);
    expect(types).toContain("process.started");
    expect(types).toContain("proposal.created");
    expect(types).not.toContain("approval.requested");
    expect(types).toContain("process.finished");

    // Approving it runs the executor, which performs the action deterministically.
    const resolved = await app.resolveProposal(pending[0]!.id, "approve");
    expect(resolved!.status).toBe("executed");
    expect(audit.all().map((e) => e.type)).toContain("proposal.executed");
    // The office action wrote a durable record into the run's shared workspace.
    const log = await fs.readFile(path.join(result.workspaceDir!, "_office_log.md"), "utf8");
    expect(log).toContain("email");

    const dash = app.dashboard();
    expect(dash.totalUsage.inputTokens).toBe(2100);
    expect(dash.pendingProposals).toBe(0); // executed, no longer pending
    expect(dash.processRuns[0]!.status).toBe("completed");
  });

  it("dry-run produces the intended send without executing it", async () => {
    const engine = new FakeEngine(() => "ok", [
      () =>
        JSON.stringify({
          done: false,
          tasks: [{ assigneeRole: "copywriter", goal: "Draft + send", definitionOfDone: "queued" }],
        }),
      async (ctx) => {
        const decision = await ctx.useTool("send_email", { to: "x@y.com" });
        return decision === "allow" ? "sent" : "not sent (dry-run)";
      },
      () => JSON.stringify({ done: true, summary: "done" }),
    ]);

    const { app, audit } = await bootApp(engine, { dryRun: true });
    const result = await app.runProcess("Prospect Outreach");

    expect(result.status).toBe("completed");
    expect(result.results[0]!.summary).toContain("not sent");
    expect(audit.all().some((e) => e.type === "tool.dry_run")).toBe(true);
    // Dry-run denies before the ask branch — nothing queued as a proposal.
    expect(audit.all().some((e) => e.type === "proposal.created")).toBe(false);
    expect(app.pendingProposals()).toHaveLength(0);
  });

  it("kill switch halts the org and tasks return aborted", async () => {
    const engine = new FakeEngine(() => JSON.stringify({ done: false, tasks: [{ assigneeRole: "researcher", goal: "g", definitionOfDone: "d" }] }));
    const { app } = await bootApp(engine);
    app.kill("*");
    const result = await app.runProcess("Prospect Outreach");
    // Owner is killed, so planning aborts and the process cannot advance.
    expect(["failed", "completed", "budget_exhausted"]).toContain(result.status);
    // Any worker task that did run came back aborted (no work performed).
    for (const r of result.results) expect(r.status).toBe("aborted");
  });
});
