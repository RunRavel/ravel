import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { App } from "../platform/app.js";
import type { EmittingAudit } from "../trust/emittingAudit.js";
import { compileRegistry, type Diagnostic } from "../control-plane/registry.js";
import { lintRegistry } from "../control-plane/lint.js";
import { declaredEnv, type DeclaredEnvEntry } from "../control-plane/declaredEnv.js";
import { runtimeVersion } from "../domain/version.js";
import { newId } from "../domain/ids.js";
import { ENV_KEY_RE } from "../secrets/store.js";
import type { ProcessRunResult } from "../orchestrator/orchestrator.js";
import { Scheduler } from "./scheduler.js";

const MAX_BODY = 32 * 1024 * 1024; // 32 MB (base64 file uploads)

/**
 * Version of the worker HTTP contract (`/api/*` + SSE), surfaced at
 * `GET /api/health`. Independent of the package version: bump only when the
 * surface changes incompatibly; additive fields/endpoints don't bump it.
 */
const API_VERSION = "1";

interface RunRecord {
  runId: string;
  processName: string;
  status: "running" | "completed" | "failed" | "stopped";
  /** Owner node id of the process — the scope we kill to stop the run. */
  owner?: string;
  result?: ProcessRunResult;
  error?: string;
}

interface ServerDeps {
  app: App;
  /** The structured-event tap the App was built with (audit). */
  events: EmittingAudit;
  /** Built operator console (ui/dist). When set, non-/api GETs serve it. */
  uiDir?: string;
  /**
   * Hosted workers get their config from a git checkout and their secrets from
   * the platform's vault — disable the HTTP write paths for both (scheduler
   * config stays writable: it's team state, not config).
   */
  readOnlyConfig?: boolean;
}

/** A local, single-operator HTTP + SSE service over one App. No auth by design. */
export function createServer(deps: ServerDeps): http.Server {
  const { app, events, uiDir, readOnlyConfig } = deps;
  const runs = new Map<string, RunRecord>();
  const orgRoot = path.resolve(app.root);
  const memRoot = path.resolve(app.runtimeDir, "memory");
  let compileVersion = 1_000_000;

  // Self-pacing auto-run scheduler. Inert unless scheduler.json enables a process.
  const scheduler = new Scheduler({
    launch: (name) => launchRun(name, {}, []),
    isLive: (name) => isProcessRunning(name),
    ownerOf: (name) => (app.currentSnapshot()?.processes ?? []).find((p) => p.spec.name === name)?.ownerNodeId ?? null,
    memory: app.memory,
    events,
    configPath: path.join(app.runtimeDir, "scheduler.json"),
  });

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  server.on("listening", () => void scheduler.start());
  server.on("close", () => scheduler.stop());
  return server;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    cors(req, res);
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    const url = new URL(req.url ?? "/", "http://localhost");
    const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const m = req.method ?? "GET";

    // --- read-only state -----------------------------------------------------
    // Health doubles as worker identity: `version` is the running runtime (may
    // differ from a checkout's installed version until the worker restarts);
    // `apiVersion` is the HTTP-surface contract handle, bumped on an
    // incompatible change (additive fields don't bump it).
    if (m === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, name: "ravel", version: runtimeVersion(), apiVersion: API_VERSION });
    }
    if (m === "GET" && url.pathname === "/api/org") return sendJson(res, 200, serializeOrg(app));
    if (m === "GET" && url.pathname === "/api/dashboard") return sendJson(res, 200, app.dashboard());
    if (m === "GET" && url.pathname === "/api/processes") {
      const procs = (app.currentSnapshot()?.processes ?? []).map((p) => ({
        name: p.spec.name,
        owner: p.ownerNodeId,
        definitionOfDone: p.spec.definitionOfDone,
        participants: p.spec.participants,
        approvals: p.spec.approvals,
        ...(p.spec.budget ? { budget: p.spec.budget } : {}),
      }));
      return sendJson(res, 200, { processes: procs });
    }
    if (m === "GET" && url.pathname === "/api/proposals") {
      const status = url.searchParams.get("status");
      const list = status === "pending" || status === null ? app.pendingProposals() : app.proposals.list(status as never);
      return sendJson(res, 200, { proposals: list });
    }

    // --- live event stream (SSE) --------------------------------------------
    if (m === "GET" && url.pathname === "/api/events") return streamEvents(res);

    // --- audit query (a filtered read over the same events the SSE emits) ----
    // Lets a consumer fold per-agent/per-run history in one call instead of
    // N `runs/:id/events` round-trips. Newest-last, capped by `limit`.
    if (m === "GET" && url.pathname === "/api/audit") {
      const since = url.searchParams.get("since");
      // A provided-but-unparseable `since` is a client error, not a silent
      // "return everything" (which is what ignoring the NaN would do).
      const sinceMs = since !== null ? Date.parse(since) : null;
      if (sinceMs !== null && Number.isNaN(sinceMs)) {
        return sendJson(res, 400, { error: "invalid 'since' (expected an ISO timestamp)" });
      }
      const nodeId = url.searchParams.get("nodeId");
      const runId = url.searchParams.get("runId");
      const type = url.searchParams.get("type");
      const limitRaw = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : 1000;
      let matched = events.all().filter((e) => {
        if (sinceMs !== null && Date.parse(e.at) < sinceMs) return false;
        // Match the node id exactly: `?nodeId=` selects the root node (whose id
        // is ""), NOT node-less system events (which have no nodeId at all).
        if (nodeId !== null && e.nodeId !== nodeId) return false;
        if (runId !== null && e.runId !== runId) return false;
        if (type !== null && e.type !== type) return false;
        return true;
      });
      // Keep the newest `limit` events, returned oldest-first (like the SSE backfill).
      if (matched.length > limit) matched = matched.slice(matched.length - limit);
      return sendJson(res, 200, { events: matched });
    }

    // --- mutations -----------------------------------------------------------
    if (m === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(req);
      const reply = await app.chat(String(body["nodeId"] ?? ""), String(body["message"] ?? ""));
      return sendJson(res, 200, { reply });
    }

    if (m === "POST" && seg[0] === "processes" && seg[2] === "run") {
      return startRun(req, res, decodeURIComponent(seg[1]!));
    }

    if (m === "POST" && seg[0] === "proposals" && seg[1]) {
      const body = await readJson(req);
      const decision = body["decision"] === "approve" ? "approve" : "reject";
      const updated = await app.resolveProposal(seg[1], decision);
      if (!updated) return sendJson(res, 404, { error: "no pending proposal with that id" });
      return sendJson(res, 200, { proposal: updated });
    }

    if (m === "POST" && url.pathname === "/api/kill") {
      const body = await readJson(req);
      return sendJson(res, 200, { aborted: app.kill(String(body["scope"] ?? "*")) });
    }

    // --- runs + artifacts ----------------------------------------------------
    if (m === "GET" && seg[0] === "runs" && seg[1] && seg[2] === "files") {
      return seg[3] ? sendRunFile(res, seg[1], decodeURIComponent(seg[3])) : listRunFiles(res, seg[1]);
    }
    if (m === "GET" && seg[0] === "runs" && seg[1] && seg[2] === "events") {
      const runId = seg[1];
      const list = events.all().filter((e) => e.runId === runId);
      return sendJson(res, 200, { events: list });
    }
    // Opt-in run transcript (WO-021/ask #25) — every turn's text, not just the
    // final one. `[]` when capture is off (`app.transcripts` undefined) or the
    // run wrote nothing; never a 404 — a missing transcript degrades cleanly.
    if (m === "GET" && seg[0] === "runs" && seg[1] && seg[2] === "transcript") {
      const entries = (await app.transcripts?.read(seg[1])) ?? [];
      return sendJson(res, 200, { transcript: entries });
    }
    if (m === "GET" && url.pathname === "/api/runs") {
      return sendJson(res, 200, { runs: listRuns() });
    }

    // --- auto-run scheduler (self-pacing) ------------------------------------
    if (m === "GET" && url.pathname === "/api/scheduler") {
      return sendJson(res, 200, scheduler.snapshot());
    }
    if (m === "PUT" && url.pathname === "/api/scheduler") {
      const body = await readJson(req);
      const name = String(body["name"] ?? "");
      if (!name) return sendJson(res, 400, { error: "name required" });
      const patch: Record<string, unknown> = {};
      if (body["enabled"] !== undefined) patch["enabled"] = Boolean(body["enabled"]);
      if (body["mode"] !== undefined) patch["mode"] = body["mode"] === "cron" ? "cron" : "adaptive";
      if (body["cron"] !== undefined) patch["cron"] = String(body["cron"]);
      if (body["minMinutes"] !== undefined) patch["minMinutes"] = Number(body["minMinutes"]);
      if (body["maxMinutes"] !== undefined) patch["maxMinutes"] = Number(body["maxMinutes"]);
      if (body["maxUsdPerDay"] !== undefined) patch["maxUsdPerDay"] = Number(body["maxUsdPerDay"]);
      try {
        await scheduler.setProcess(name, patch);
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return sendJson(res, 200, scheduler.snapshot());
    }
    if (m === "DELETE" && url.pathname === "/api/scheduler") {
      const name = url.searchParams.get("name") ?? "";
      if (!name) return sendJson(res, 400, { error: "name required" });
      await scheduler.removeProcess(name);
      return sendJson(res, 200, scheduler.snapshot());
    }

    // --- budget limits (operator-set spend ceilings; team state, not config) --
    // Writes stay enabled under --read-only-config, same reason as the
    // scheduler: this is operator-editable team state, never git-sourced.
    if (m === "GET" && url.pathname === "/api/limits") {
      return sendJson(res, 200, { document: app.limits.get() });
    }
    if (m === "PUT" && url.pathname === "/api/limits") {
      const body = await readJson(req);
      try {
        const document = await app.limits.set(body);
        return sendJson(res, 200, { document });
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (m === "DELETE" && url.pathname === "/api/limits") {
      await app.limits.clear();
      return sendJson(res, 200, { document: null });
    }
    if (m === "POST" && seg[0] === "runs" && seg[1] && seg[2] === "dismiss") {
      runs.delete(seg[1]);
      await events.append("run.dismissed", { runId: seg[1], data: {} });
      return sendJson(res, 200, { ok: true });
    }
    if (m === "POST" && seg[0] === "runs" && seg[1] && seg[2] === "stop") {
      const rec = runs.get(seg[1]);
      if (!rec) return sendJson(res, 404, { error: "no live run with that id" });
      // Halt the run by killing its owner subtree: the in-flight agent aborts and
      // the orchestrator winds down. The owner scope is cleared when the run settles
      // (see startRun) so the team can run again.
      const aborted = rec.owner !== undefined ? app.kill(rec.owner) : app.kill("*");
      rec.status = "stopped";
      await events.append("run.stopped", { runId: seg[1], nodeId: rec.owner, data: { aborted } });
      return sendJson(res, 200, { stopped: true, aborted });
    }
    if (m === "GET" && url.pathname === "/api/chats") {
      const nodeId = url.searchParams.get("nodeId") ?? "";
      return sendJson(res, 200, { turns: chatHistory(nodeId) });
    }
    // --- memory as a file tree (read-only) -----------------------------------
    if (m === "GET" && url.pathname === "/api/mem/tree") {
      return sendJson(res, 200, { tree: await walkMem(memRoot, "") });
    }
    if (m === "GET" && url.pathname === "/api/mem/file") {
      const rel = url.searchParams.get("path") ?? "";
      const abs = memSafe(rel);
      if (!abs) return sendJson(res, 400, { error: "path escapes memory root" });
      const st = await fs.stat(abs).catch(() => null);
      if (!st || !st.isFile()) return sendJson(res, 404, { error: "not found" });
      const content = await fs.readFile(abs, "utf8");
      return sendJson(res, 200, { path: rel, content, mtimeMs: st.mtimeMs, size: st.size });
    }
    if (m === "GET" && seg[0] === "runs" && seg[1]) {
      const rec = runs.get(seg[1]);
      return rec ? sendJson(res, 200, rec) : sendJson(res, 404, { error: "unknown run" });
    }

    // --- per-agent secrets (masked: names only; values never returned) -------
    if (m === "GET" && url.pathname === "/api/secrets") {
      const dir = nodeDir(url.searchParams.get("nodeId") ?? "");
      if (!dir) return sendJson(res, 404, { error: "unknown node" });
      return sendJson(res, 200, { keys: await app.secrets.listKeys(dir) });
    }
    if (m === "PUT" && url.pathname === "/api/secrets") {
      if (readOnlyConfig) return sendJson(res, 403, { error: "config is read-only on this worker" });
      const body = await readJson(req);
      const dir = nodeDir(String(body["nodeId"] ?? ""));
      if (!dir) return sendJson(res, 404, { error: "unknown node" });
      const key = String(body["key"] ?? "");
      const action = body["action"] === "delete" ? "delete" : "set";
      if (!ENV_KEY_RE.test(key)) return sendJson(res, 400, { error: "invalid key (use A-Z, 0-9, _)" });
      if (action === "delete") await app.secrets.deleteKey(dir, key);
      else await app.secrets.setKey(dir, key, String(body["value"] ?? ""));
      return sendJson(res, 200, { keys: await app.secrets.listKeys(dir) });
    }

    // --- config authoring ----------------------------------------------------
    if (m === "GET" && url.pathname === "/api/validate") {
      return sendJson(res, 200, await compileAndLint());
    }
    if (m === "GET" && url.pathname === "/api/files") {
      const rel = url.searchParams.get("path") ?? "";
      const abs = safePath(rel);
      if (!abs) return sendJson(res, 400, { error: "path escapes org root" });
      const content = await fs.readFile(abs, "utf8").catch(() => null);
      return content === null ? sendJson(res, 404, { error: "not found" }) : sendJson(res, 200, { path: rel, content });
    }
    if (m === "PUT" && url.pathname === "/api/files") {
      if (readOnlyConfig) return sendJson(res, 403, { error: "config is read-only on this worker" });
      const body = await readJson(req);
      const rel = String(body["path"] ?? "");
      const abs = safePath(rel);
      if (!abs || !isAuthoringFile(rel)) {
        return sendJson(res, 400, { error: "path must be agent.md, tools.json, or processes/*.process.md within the org" });
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(body["content"] ?? ""), "utf8");
      // Validate synchronously; the watcher hot-reloads the live org separately.
      return sendJson(res, 200, await compileAndLint());
    }

    // --- operator console (static, same origin as the API) -------------------
    if (m === "GET" && uiDir && !url.pathname.startsWith("/api")) {
      return sendUiFile(res, uiDir, url.pathname);
    }

    sendJson(res, 404, { error: `no route for ${m} ${url.pathname}` });
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * Compile the org and, if it compiles clean, run the advisory lint (full
   * context: loaded plugin tool names + per-node secrets) so `/api/validate`
   * and a config save return the SAME severity-tagged diagnostics `-v`/`serve`
   * would surface — the metadata a hosting platform or the console needs to
   * show warnings without scraping stderr.
   */
  async function compileAndLint(): Promise<{ ok: boolean; diagnostics: Diagnostic[]; declaredEnv?: DeclaredEnvEntry[] }> {
    const result = await compileRegistry(orgRoot, ++compileVersion);
    if (!result.ok || !result.snapshot) return { ok: false, diagnostics: result.diagnostics };
    const warnings = await lintRegistry(result.snapshot, {
      secrets: app.secrets,
      pluginToolNamesByNode: (nodeId) => (app.plugins.forNode(nodeId)?.tools ?? []).map((t) => t.name),
    });
    return { ok: true, diagnostics: [...result.diagnostics, ...warnings], declaredEnv: declaredEnv(result.snapshot) };
  }

  interface RunSummary {
    runId: string;
    process: string;
    owner: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    turns?: number;
    usd?: number;
    error?: string;
    inputs?: Record<string, unknown>;
    /**
     * Task-status breakdown for the run. `status` above answers "did the owner
     * achieve the goal"; this answers "did anything break along the way" — a
     * `completed` run can still contain failed tasks the orchestrator recovered
     * from. Derived from `task.finished` events; not a status enum.
     */
    tasks: { total: number; failed: number; aborted: number; budget_exhausted: number };
    /** Count of tool calls in the run (`tool.started` events). */
    toolCalls: number;
  }

  /**
   * All runs — live and past — built from the durable audit trail (so it
   * survives navigation and restarts).
   *
   * A run that the audit shows as started-but-not-finished is only really
   * "running" if THIS process is executing it (it's in the in-memory `runs`
   * map). Otherwise it was interrupted by a crash/restart and is marked
   * "interrupted" rather than falsely "running". Dismissed runs are hidden.
   */
  function listRuns(): RunSummary[] {
    const byId = new Map<string, RunSummary>();
    const dismissed = new Set<string>();
    for (const e of events.all()) {
      if (!e.runId) continue;
      if (e.type === "process.started") {
        byId.set(e.runId, {
          runId: e.runId,
          process: String(e.data["process"] ?? ""),
          owner: e.nodeId ?? "",
          status: "running",
          startedAt: e.at,
          tasks: { total: 0, failed: 0, aborted: 0, budget_exhausted: 0 },
          toolCalls: 0,
          ...(e.data["inputs"] ? { inputs: e.data["inputs"] as Record<string, unknown> } : {}),
        });
      } else if (e.type === "process.finished") {
        const r = byId.get(e.runId);
        if (r) {
          r.status = String(e.data["status"] ?? r.status);
          r.finishedAt = e.at;
          r.turns = Number(e.data["turns"] ?? 0);
          const usage = e.data["usage"] as { usd?: number } | undefined;
          if (usage) r.usd = usage.usd;
        }
      } else if (e.type === "task.finished") {
        const r = byId.get(e.runId);
        if (r) {
          r.tasks.total += 1;
          const s = String(e.data["status"] ?? "");
          if (s === "failed") r.tasks.failed += 1;
          else if (s === "aborted") r.tasks.aborted += 1;
          else if (s === "budget_exhausted") r.tasks.budget_exhausted += 1;
        }
      } else if (e.type === "tool.started") {
        const r = byId.get(e.runId);
        if (r) r.toolCalls += 1;
      } else if (e.type === "run.dismissed") {
        dismissed.add(e.runId);
      }
    }
    for (const id of dismissed) byId.delete(id);
    // An operator stop wins over whatever the audit recorded for the wind-down.
    for (const [id, r] of byId) {
      if (runs.get(id)?.status === "stopped") r.status = "stopped";
    }
    // Reconcile "running": only genuinely live if this process is executing it.
    for (const [id, r] of byId) {
      if (r.status !== "running") continue;
      const live = runs.get(id);
      if (live) {
        if (live.status === "failed") {
          r.status = "failed";
          if (live.error) r.error = live.error;
        }
        // else: truly running in this process — leave as "running".
      } else {
        r.status = "interrupted"; // started in a prior process; never finished.
      }
    }
    return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Absolute folder for a node id, or null if unknown. (For per-node secrets.) */
  function nodeDir(nodeId: string): string | null {
    const node = app.currentSnapshot()?.nodes.get(nodeId);
    return node ? node.dir : null;
  }

  /** Reconstruct an agent's chat history from the audit trail (durable). */
  function chatHistory(nodeId: string): Array<{ who: "me" | "agent"; text: string; at: string }> {
    const turns: Array<{ who: "me" | "agent"; text: string; at: string }> = [];
    for (const e of events.all()) {
      if (e.nodeId !== nodeId) continue;
      if (e.type === "chat.message") turns.push({ who: "me", text: String(e.data["message"] ?? ""), at: e.at });
      else if (e.type === "chat.reply") turns.push({ who: "agent", text: String(e.data["reply"] ?? ""), at: e.at });
    }
    return turns;
  }

  async function startRun(req: http.IncomingMessage, res: http.ServerResponse, name: string): Promise<void> {
    const body = await readJson(req);
    const inputs = (body["inputs"] as Record<string, unknown> | undefined) ?? {};
    const uploads = (body["files"] as Array<{ name: string; contentBase64: string }> | undefined) ?? [];

    const runId = newId("run");
    const files: string[] = [];
    if (uploads.length) {
      const dir = path.join(app.runtimeDir, ".uploads", runId);
      await fs.mkdir(dir, { recursive: true });
      for (const f of uploads) {
        const dest = path.join(dir, path.basename(f.name));
        await fs.writeFile(dest, Buffer.from(f.contentBase64, "base64"));
        files.push(dest);
      }
    }
    launchRun(name, inputs, files, runId);
    sendJson(res, 202, { runId });
  }

  /**
   * Fire a process run in the background (used by the HTTP route AND the
   * scheduler). Returns the runId immediately; progress streams over SSE.
   */
  function launchRun(name: string, inputs: Record<string, unknown>, files: string[], runId = newId("run")): string {
    // The process owner is the scope we kill to stop the run.
    const owner = (app.currentSnapshot()?.processes ?? []).find((p) => p.spec.name === name)?.ownerNodeId;
    runs.set(runId, { runId, processName: name, status: "running", ...(owner !== undefined ? { owner } : {}) });
    const stamp = (patch: Partial<RunRecord>) => {
      const prev = runs.get(runId);
      // Don't overwrite an operator "stopped" with the orchestrator's wind-down status.
      if (prev?.status === "stopped" && patch.status !== "stopped") patch = { ...patch, status: "stopped" };
      runs.set(runId, { runId, processName: name, ...(owner !== undefined ? { owner } : {}), status: "running", ...patch });
    };
    void app
      .runProcess(name, { runId, inputs, ...(files.length ? { files } : {}) })
      .then((result) => stamp({ status: "completed", result }))
      .catch((err: unknown) => stamp({ status: "failed", error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        // Unblock the team for future runs (no-op if it was never killed).
        if (owner !== undefined) app.clearKill(owner);
      });
    return runId;
  }

  /** True if a run of this process is currently executing in this process (single-flight). */
  function isProcessRunning(name: string): boolean {
    for (const r of runs.values()) if (r.processName === name && r.status === "running") return true;
    return false;
  }

  async function listRunFiles(res: http.ServerResponse, runId: string): Promise<void> {
    const dir = path.join(app.runtimeDir, "runs", runId, "shared");
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    sendJson(res, 200, { files: entries.sort() });
  }

  async function sendRunFile(res: http.ServerResponse, runId: string, name: string): Promise<void> {
    const file = path.join(app.runtimeDir, "runs", runId, "shared", path.basename(name));
    const content = await fs.readFile(file, "utf8").catch(() => null);
    if (content === null) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(content);
  }

  function streamEvents(res: http.ServerResponse): void {
    // CORS was already decided per-origin in cors(); don't re-widen it here.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (kind: string, data: unknown) => res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
    // Backfill recent history so a fresh client has context.
    for (const e of events.all().slice(-200)) send("audit", e);
    const onAudit = (e: unknown) => send("audit", e);
    const onProposal = (p: unknown) => send("proposal", p);
    events.on("event", onAudit);
    app.proposals.on("created", onProposal);
    app.proposals.on("updated", onProposal);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    res.on("close", () => {
      clearInterval(ping);
      events.off("event", onAudit);
      app.proposals.off("created", onProposal);
      app.proposals.off("updated", onProposal);
    });
  }

  function safePath(rel: string): string | null {
    const abs = path.resolve(orgRoot, rel);
    return abs === orgRoot || abs.startsWith(orgRoot + path.sep) ? abs : null;
  }

  // --- memory file tree (read-only browser) ----------------------------------
  function memSafe(rel: string): string | null {
    const abs = path.resolve(memRoot, rel);
    return abs === memRoot || abs.startsWith(memRoot + path.sep) ? abs : null;
  }
  async function walkMem(absDir: string, relDir: string): Promise<unknown[]> {
    const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
    const nodes: unknown[] = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: rel, type: "dir", children: await walkMem(abs, rel) });
      } else {
        const st = await fs.stat(abs).catch(() => null);
        nodes.push({ name: e.name, path: rel, type: "file", size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 });
      }
    }
    return nodes;
  }

  async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  }
}

const UI_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Serve the built operator console. Extensionless misses fall back to the app
 * shell (client-side routes); missing assets are a real 404.
 */
async function sendUiFile(res: http.ServerResponse, uiDir: string, pathname: string): Promise<void> {
  const root = path.resolve(uiDir);
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return sendJson(res, 400, { error: "path escapes ui root" });
  let file = abs;
  let content = await fs.readFile(file).catch(() => null);
  if (content === null && !path.extname(rel)) {
    file = path.join(root, "index.html");
    content = await fs.readFile(file).catch(() => null);
  }
  if (content === null) return sendJson(res, 404, { error: "not found" });
  const type = UI_CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type }).end(content);
}

/** Authoring files the config editor is allowed to write. */
function isAuthoringFile(rel: string): boolean {
  const base = path.basename(rel);
  return base === "agent.md" || base === "tools.json" || rel.replace(/\\/g, "/").includes("processes/") && base.endsWith(".process.md");
}

function serializeOrg(app: App): unknown {
  const snap = app.currentSnapshot();
  if (!snap) return { nodes: [], processes: [] };
  return {
    rootId: snap.rootId,
    version: snap.version,
    nodes: [...snap.nodes.values()].map((n) => ({
      id: n.id,
      name: n.spec.name,
      role: n.spec.role ?? n.spec.name,
      parentId: n.parentId,
      childIds: n.childIds,
      autonomy: n.spec.autonomy,
      model: n.spec.model ?? null,
      tools: n.tools.tools.map((t) => ({ name: t.name, policy: t.policy })),
      processCount: n.processes.length,
    })),
    processes: snap.processes.map((p) => ({ name: p.spec.name, owner: p.ownerNodeId, path: p.path })),
  };
}

/**
 * CORS: grant only loopback origins (the console or a dev server on this
 * machine). The API is auth-free by design, so a permissive "*" would let any
 * website the operator's browser visits drive it cross-origin (CSRF /
 * DNS-rebinding); non-local origins get no CORS grant at all.
 */
function cors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && isLoopbackOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}
