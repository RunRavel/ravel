#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { App } from "../platform/app.js";
import { SdkEngine } from "../runtime/sdkEngine.js";
import { createServer } from "../service/server.js";
import { EmittingAudit } from "../trust/emittingAudit.js";
import { JsonlAudit, type LogFormat } from "../trust/audit.js";
import { compileRegistry, type Diagnostic } from "../control-plane/registry.js";
import { lintRegistry } from "../control-plane/lint.js";
import { declaredEnv } from "../control-plane/declaredEnv.js";
import { parseDotEnv, SecretStore } from "../secrets/store.js";
import type { ApprovalRequest, Usage } from "../domain/types.js";
import { totalTokens } from "../domain/types.js";

const HELP = `Ravel — run an agentic team defined as a folder tree.

Usage:
  ravel create <name>
  ravel validate [--dir <org>]
  ravel run <process-name> [--dir <org>] [--dry-run] [--sync] [--capture-transcripts] [--input k=v]... [--file <path>]...
  ravel chat <node-id> <message...> [--dir <org>]
  ravel proposals [list|approve <id>|reject <id>] [--dir <org>]
  ravel dashboard [--dir <org>]
  ravel watch [--dir <org>]
  ravel serve [--dir <org>] [--port 4317] [--host 127.0.0.1] [--state-dir <path>] [--read-only-config] [--capture-transcripts]

Options:
  --dir <path>        Org root folder (default: current directory)
  --host <addr>       Interface to bind (default: 127.0.0.1 — loopback only.
                      The API has no auth; use 0.0.0.0 only behind a gateway)
  --state-dir <path>  Where runtime state (memory, audit, runs) lives
                      (default: <org>/.ravel)
  --read-only-config  Disable config/secret writes over HTTP (PUT /api/files,
                      PUT /api/secrets) — for workers whose config comes from git
  --capture-transcripts  Record every turn's agent-authored text per run (not just
                      the final turn's ~8000-char summary) to
                      <state-dir>/runs/<runId>/transcript.jsonl, readable over
                      GET /api/runs/:id/transcript. Off by default — this can add
                      meaningfully to disk use on a long-running worker
  --dry-run           Agents produce intended actions but execute no tools
  --sync              Block on consequential actions with an interactive y/N prompt
                      (default is async: actions queue as proposals to approve later)
  --input k=v         Run input passed to the process (repeatable)
  --file <path>       Source file staged into each dispatched worker's workdir (repeatable)
  -v, --verbose       Stream the audit trail (turns, dispatches, tools, proposals) to stderr
  --log-format <fmt>  pretty (default) or json (NDJSON, one object per line, with a
                      "level" field — for log aggregators). Implies --verbose.
                      Also settable via RAVEL_LOG_FORMAT.
  --json              validate: emit one JSON object (ok, nodes, diagnostics with
                      code/severity, declaredEnv with nodePath/key) instead of
                      human-readable text

Example:
  ravel create my-team && ravel serve --dir my-team
  ravel run "Resolve Ticket Batch" --dir examples/harbor \\
    --file ./tickets.json --input product="Acme CRM"
`;

/**
 * Load `.env` files into process.env without clobbering already-exported vars
 * (existing environment wins, per dotenv convention). Tries the current dir and
 * the org `--dir`, so credentials can live next to the org folder.
 */
async function loadEnvFiles(orgDir: string): Promise<void> {
  const seen = new Set<string>();
  for (const dir of [process.cwd(), path.resolve(orgDir)]) {
    const file = path.join(dir, ".env");
    if (seen.has(file)) continue;
    seen.add(file);
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue; // no .env here — fine
    }
    // Global base layer: cwd + org-root .env into process.env (existing env wins).
    for (const [key, value] of Object.entries(parseDotEnv(content))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

/**
 * Resolve the verbose stream's on/off state and format. `--log-format` (or
 * `RAVEL_LOG_FORMAT`) implies the stream is on even without `-v` — specifying a
 * format for a disabled stream would otherwise silently do nothing.
 */
function resolveLogging(values: { verbose?: boolean; "log-format"?: string }): { verbose: boolean; logFormat: LogFormat } {
  const raw = values["log-format"] ?? process.env["RAVEL_LOG_FORMAT"];
  const logFormat: LogFormat = raw === "json" ? "json" : "pretty";
  return { verbose: Boolean(values.verbose) || raw !== undefined, logFormat };
}

/**
 * One NDJSON line for the CLI's OWN messages (not audit events — the API-key
 * warning, the startup banner, an unhandled-rejection guard) so
 * `--log-format json` covers everything the process emits, not just the
 * audit trail. `message` should be clean prose (no "· " prefix, no baked-in
 * detail) — put per-instance specifics in `data`.
 */
function jsonLine(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): string {
  return JSON.stringify({ at: new Date().toISOString(), level, message, ...(data ? { data } : {}) });
}

/**
 * Group diagnostics by `code` for compact CLI output — every lint message
 * follows `<specific clause> — <shared rule explanation>`, so splitting on the
 * first " — " lets a repeated rule (e.g. 14 "memory-write" warnings across a
 * team) print its explanation once instead of 14 times.
 */
function groupDiagnostics(diagnostics: Diagnostic[]): Array<[string, Array<{ where: string; headline: string; detail: string }>]> {
  const groups = new Map<string, Array<{ where: string; headline: string; detail: string }>>();
  for (const d of diagnostics) {
    const code = d.code ?? d.message;
    const idx = d.message.indexOf(" — ");
    const headline = idx === -1 ? d.message : d.message.slice(0, idx);
    const detail = idx === -1 ? "" : d.message.slice(idx + 3);
    const group = groups.get(code) ?? [];
    group.push({ where: d.where, headline, detail });
    groups.set(code, group);
  }
  return [...groups.entries()];
}

function fmtUsage(u: Usage): string {
  const total = totalTokens(u);
  const cached = u.cacheReadTokens;
  const hitRate = total > 0 ? Math.round((cached / total) * 100) : 0;
  return `${total} tok ($${u.usd.toFixed(4)}) · ${hitRate}% cache hit (${cached} read / ${u.cacheCreationTokens} written)`;
}

/** Wire the approval queue to an interactive y/n prompt on the terminal. */
function attachInteractiveApprovals(app: App): () => void {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const handler = async (req: ApprovalRequest) => {
    stdout.write(`\n⚠️  Approval needed — agent "${req.nodeId}" wants to use "${req.toolName}"\n`);
    stdout.write(`    input: ${JSON.stringify(req.input)}\n`);
    if (req.rationale) stdout.write(`    why:   ${req.rationale}\n`);
    const answer = (await rl.question("    allow? [y/N] ")).trim().toLowerCase();
    await app.resolveApproval(req.id, answer === "y" || answer === "yes" ? "allow" : "deny");
  };
  app.approvals.on("requested", handler);
  return () => {
    app.approvals.off("requested", handler);
    rl.close();
  };
}

/** Resolve when the process is asked to shut down (Ctrl-C or a container stop). */
function shutdownSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

/** Boot the App + HTTP service and run until interrupted. */
async function runServe(
  root: string,
  port: number,
  verbose: boolean,
  opts: { stateDir?: string; readOnlyConfig?: boolean; host?: string; logFormat?: LogFormat; captureTranscripts?: boolean } = {},
): Promise<number> {
  // A single run's abort (budget/turn cap, kill switch, or the Agent SDK's own
  // detached internals) must never take the whole long-running service down. The
  // SDK can surface an AbortError asynchronously after we've already handled the
  // run; swallow those and log anything else, but keep serving — crashing would
  // lose every in-flight run and the operator's queue.
  const logFormat = opts.logFormat ?? "pretty";
  const guard = (kind: string) => (err: unknown) => {
    const e = err as { name?: string; message?: string } | undefined;
    const msg = e?.message ?? String(err);
    if (e?.name === "AbortError" || /abort/i.test(msg)) {
      if (verbose) {
        const line = logFormat === "json" ? jsonLine("info", `${kind} ignored (a run was aborted)`, { kind, error: msg }) : `· ${kind} ignored (a run was aborted): ${msg}`;
        process.stderr.write(`${line}\n`);
      }
      return;
    }
    const line = logFormat === "json" ? jsonLine("error", `${kind} (service stays up)`, { kind, error: msg }) : `· ${kind} (service stays up): ${msg}`;
    process.stderr.write(`${line}\n`);
  };
  process.on("unhandledRejection", guard("unhandledRejection"));
  process.on("uncaughtException", guard("uncaughtException"));

  const runtimeDir = opts.stateDir ? path.resolve(opts.stateDir) : path.join(root, ".ravel");
  // EmittingAudit feeds the SSE stream; with -v, App also wraps it in a
  // LoggingAudit that tees each event to stderr (append flows through both).
  const events = new EmittingAudit(new JsonlAudit(path.join(runtimeDir, "audit.jsonl")));
  const app = new App({
    root,
    engine: new SdkEngine(),
    audit: events,
    runtimeDir,
    ...(opts.captureTranscripts ? { captureTranscripts: true } : {}),
    ...(verbose
      ? { verbose: (line: string) => process.stderr.write(`${line}\n`), logFormat: opts.logFormat ?? "pretty" }
      : {}),
  });
  await app.start();

  // Serve the built operator console (ui/dist, shipped with the package) from
  // the same port. Absent a build, the API still serves — console devs use the
  // Vite dev server (`cd ui && npm run dev`) for HMR instead.
  const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
  const hasUi = await fs.access(path.join(uiDir, "index.html")).then(() => true).catch(() => false);
  const server = createServer({
    app,
    events,
    ...(hasUi ? { uiDir } : {}),
    ...(opts.readOnlyConfig ? { readOnlyConfig: true } : {}),
  });
  // Loopback by default: the API is deliberately auth-free (single local
  // operator), so exposing it on other interfaces is an explicit opt-in.
  const host = opts.host ?? "127.0.0.1";
  // A bind failure (e.g. EADDRINUSE) is a fatal boot error: reject so the
  // process exits non-zero instead of being swallowed by the run-error guard
  // and hanging — the worker contract promises a clear failure, not a timeout.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const consoleUrl = hasUi ? `http://localhost:${port}/` : null;
  if (logFormat === "json") {
    stdout.write(`${jsonLine("info", "Ravel service listening", { host, port, org: root, hasUi, consoleUrl })}\n`);
  } else {
    stdout.write(`Ravel service on http://${host}:${port}  (org: ${root})\n`);
    if (hasUi) stdout.write(`Operator console: ${consoleUrl}\n`);
    else stdout.write(`No built console found — \`cd ui && npm run build\` to serve it from this port.\n`);
    stdout.write(`Proposals queue is async — review at /api/proposals or in the console. Ctrl-C to stop.\n`);
  }

  await shutdownSignal();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.stop();
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      "dry-run": { type: "boolean" },
      input: { type: "string", multiple: true },
      file: { type: "string", multiple: true },
      verbose: { type: "boolean", short: "v" },
      "log-format": { type: "string" },
      sync: { type: "boolean" },
      port: { type: "string" },
      host: { type: "string" },
      "state-dir": { type: "string" },
      "read-only-config": { type: "boolean" },
      "capture-transcripts": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];
  const root = values.dir ?? process.cwd();

  if (values.help || !command) {
    stdout.write(HELP);
    return 0;
  }

  if (command === "validate") {
    const result = await compileRegistry(root, 1);
    if (!result.ok || !result.snapshot) {
      if (values.json) {
        stdout.write(`${JSON.stringify({ ok: false, diagnostics: result.diagnostics })}\n`);
        return 1;
      }
      stdout.write("✗ invalid:\n");
      for (const d of result.diagnostics) stdout.write(`  ✗ ${d.where}: ${d.message}\n`);
      return 1;
    }
    // Compiled clean → run the advisory lint (env + generic-mem-write). Plugin
    // tool names aren't loaded here, so unknown-tool checks are serve-only.
    const warnings = await lintRegistry(result.snapshot, { secrets: new SecretStore(root) });
    if (values.json) {
      stdout.write(
        `${JSON.stringify({
          ok: true,
          nodes: [...result.snapshot.nodes.keys()],
          processCount: result.snapshot.processes.length,
          diagnostics: warnings,
          declaredEnv: declaredEnv(result.snapshot),
        })}\n`,
      );
      return 0;
    }
    stdout.write(`✓ valid — ${result.snapshot.nodes.size} agent(s), ${result.snapshot.processes.length} process(es)\n`);
    for (const id of result.snapshot.nodes.keys()) stdout.write(`  • ${id || "(root)"}\n`);
    if (warnings.length) {
      stdout.write(`\n${warnings.length} warning(s):\n`);
      for (const [code, group] of groupDiagnostics(warnings)) {
        stdout.write(`\n⚠ ${code} (${group.length}) — ${group[0]!.detail}\n`);
        for (const g of group) stdout.write(`    ${g.where}: ${g.headline}\n`);
      }
    }
    return 0;
  }

  if (command === "create") {
    const name = positionals[1];
    if (!name) {
      stdout.write("error: `create` requires a team name (e.g. `ravel create my-team`)\n");
      return 1;
    }
    const dir = path.resolve(name);
    if (await fs.access(dir).then(() => true).catch(() => false)) {
      stdout.write(`error: "${name}" already exists\n`);
      return 1;
    }
    await scaffoldTeam(dir, path.basename(dir));
    stdout.write(`✓ created team "${name}"\n\n  cd ${name}\n  npm install\n  npm run dev\n`);
    return 0;
  }

  // Load .env so ANTHROPIC_API_KEY (and friends) reach the SDK.
  await loadEnvFiles(root);
  const logging = resolveLogging(values);
  if (process.env["ANTHROPIC_API_KEY"] === undefined && process.env["ANTHROPIC_AUTH_TOKEN"] === undefined) {
    const msg = "no ANTHROPIC_API_KEY found (checked env and .env in the current dir and --dir). Set it in .env or export it, or run `ant auth login`.";
    stdout.write(`${logging.logFormat === "json" ? jsonLine("warn", msg) : `warning: ${msg}`}\n`);
  }

  if (command === "serve") {
    return runServe(root, values.port ? Number(values.port) : 4317, logging.verbose, {
      ...(values.host ? { host: values.host } : {}),
      ...(values["state-dir"] ? { stateDir: values["state-dir"] } : {}),
      ...(values["read-only-config"] ? { readOnlyConfig: true } : {}),
      ...(values["capture-transcripts"] ? { captureTranscripts: true } : {}),
      logFormat: logging.logFormat,
    });
  }

  const app = new App({
    root,
    engine: new SdkEngine(),
    ...(values["state-dir"] ? { runtimeDir: path.resolve(values["state-dir"]) } : {}),
    ...(values["dry-run"] ? { dryRun: true } : {}),
    ...(values.sync ? { approvals: "sync" as const } : {}),
    ...(values["capture-transcripts"] ? { captureTranscripts: true } : {}),
    ...(logging.verbose
      ? { verbose: (line: string) => process.stderr.write(`${line}\n`), logFormat: logging.logFormat }
      : {}),
  });
  await app.start();

  try {
    switch (command) {
      case "run": {
        const processName = positionals[1];
        if (!processName) {
          stdout.write("error: `run` requires a process name\n");
          return 1;
        }
        const inputs: Record<string, string> = {};
        for (const pair of values.input ?? []) {
          const eq = pair.indexOf("=");
          if (eq === -1) {
            stdout.write(`error: --input must be key=value (got "${pair}")\n`);
            return 1;
          }
          inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        const files = (values.file ?? []).map((f) => path.resolve(f));
        const detach = values.sync ? attachInteractiveApprovals(app) : () => {};
        try {
          const result = await app.runProcess(processName, {
            ...(Object.keys(inputs).length ? { inputs } : {}),
            ...(files.length ? { files } : {}),
          });
          stdout.write(`\n[${result.status}] ${result.processName} (${result.turns} turn(s), ${fmtUsage(result.usage)})\n`);
          stdout.write(`${result.summary}\n`);
          if (result.workspaceDir) {
            stdout.write(`\nDeliverables (shared workspace): ${result.workspaceDir}\n`);
            try {
              const entries = await fs.readdir(result.workspaceDir);
              for (const e of entries.sort()) stdout.write(`  • ${e}\n`);
            } catch {
              /* dir may not exist if nothing was written */
            }
          }
          const pending = app.pendingProposals();
          if (pending.length) {
            stdout.write(`\n${pending.length} action(s) awaiting approval (\`ravel proposals\` to review):\n`);
            for (const p of pending) stdout.write(`  • ${p.id}  ${p.action}  ${JSON.stringify(p.input)}\n`);
          }
        } finally {
          detach();
        }
        return 0;
      }
      case "proposals": {
        const sub = positionals[1] ?? "list";
        if (sub === "list") {
          const pending = app.pendingProposals();
          if (!pending.length) stdout.write("No pending proposals.\n");
          for (const p of pending) {
            stdout.write(`• ${p.id}  [${p.nodeId || "(root)"}] ${p.action}  ${JSON.stringify(p.input)}\n`);
          }
          return 0;
        }
        if (sub === "approve" || sub === "reject") {
          const id = positionals[2];
          if (!id) {
            stdout.write(`error: \`proposals ${sub}\` requires a proposal id\n`);
            return 1;
          }
          const updated = await app.resolveProposal(id, sub === "approve" ? "approve" : "reject");
          if (!updated) {
            stdout.write(`No pending proposal with id "${id}".\n`);
            return 1;
          }
          stdout.write(`${updated.action} → ${updated.status}${updated.error ? ` (${updated.error})` : ""}\n`);
          return 0;
        }
        stdout.write(`unknown proposals subcommand "${sub}" (use list|approve <id>|reject <id>)\n`);
        return 1;
      }
      case "chat": {
        const nodeId = positionals[1] ?? "";
        const message = positionals.slice(2).join(" ");
        if (!message) {
          stdout.write("error: `chat` requires a message\n");
          return 1;
        }
        const detach = values.sync ? attachInteractiveApprovals(app) : () => {};
        try {
          stdout.write(`${await app.chat(nodeId, message)}\n`);
        } finally {
          detach();
        }
        return 0;
      }
      case "dashboard": {
        const d = app.dashboard();
        stdout.write(`Total spend: ${fmtUsage(d.totalUsage)} · ${d.eventCount} events · ${d.pendingProposals} pending proposal(s)\n`);
        for (const a of d.agents) {
          stdout.write(`  • ${a.nodeId || "(root)"} [${a.role}] ${a.state} — ${a.tasksRun} task(s), ${fmtUsage(a.usage)}\n`);
        }
        return 0;
      }
      case "watch": {
        attachInteractiveApprovals(app);
        stdout.write(`Watching ${root}. Edit the folder to reshape the org. Ctrl-C to stop.\n`);
        await shutdownSignal();
        return 0;
      }
      default:
        stdout.write(`unknown command "${command}"\n\n${HELP}`);
        return 1;
    }
  } finally {
    await app.stop();
  }
}

/** Scaffold a minimal, valid starter team folder (a lead + one assistant + a process). */
async function scaffoldTeam(dir: string, name: string): Promise<void> {
  const write = async (rel: string, content: string) => {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  };
  // A team is an npm package: it pins the runtime it was authored against, so
  // `npm install` in the team folder (and, later, a hosting platform's `npm ci`)
  // gets exactly that version — the same portability every JS project expects.
  await write(
    "package.json",
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        private: true,
        type: "module",
        dependencies: { "@runravel/ravel": "^0.3" },
        scripts: {
          dev: "ravel serve --dir .",
          validate: "ravel validate --dir .",
          // Generic-PaaS entrypoint. A hardened/multi-tenant host invokes the
          // ravel binary directly with --read-only-config/--state-dir/--log-format
          // rather than running this script (see docs).
          start: "ravel serve --dir . --host 0.0.0.0 --port ${PORT:-4317}",
        },
      },
      null,
      2,
    ) + "\n",
  );
  await write(
    "ravel.json",
    JSON.stringify({ name, runtimeVersion: "^0.3", description: `The ${name} team.` }, null, 2) + "\n",
  );
  await write(
    "agent.md",
    `---\nname: ${name} Lead\nrole: lead\nmodel: sonnet\nautonomy: orchestrated\nbudget:\n  usd: 2\n  turns: 6\n---\n` +
      `You lead the **${name}** team. You own the **Hello** process and delegate to your\n` +
      `report, the **assistant**. Dispatch the assistant to do the work, then mark the\n` +
      `process done with a one-line summary.\n`,
  );
  await write(
    "assistant/agent.md",
    `---\nname: Assistant\nrole: assistant\nmodel: sonnet\nautonomy: orchestrated\n---\n` +
      `You carry out the task you're given and report back in one line. Keep it simple:\n` +
      `do exactly what's asked and summarize the result.\n`,
  );
  await write(
    "assistant/tools.json",
    JSON.stringify(
      {
        defaultPolicy: "ask",
        builtins: "none",
        tools: [],
        mcpServers: {},
      },
      null,
      2,
    ) + "\n",
  );
  await write(
    "processes/hello.process.md",
    `---\nname: Hello\nowner: lead\nparticipants: [assistant]\ntrigger:\n  type: manual\ndefinitionOfDone: >\n` +
      `  The assistant composed a friendly greeting for \`who\` and reported it.\nbudget:\n  usd: 1\n  turns: 4\n---\n` +
      `Dispatch the **assistant** to compose a friendly greeting (from the run input \`who\`,\n` +
      `defaulting to "world") and report it back, then mark the process done.\n`,
  );
  await write(
    ".gitignore",
    `node_modules/\n.env\n.env.local\n.DS_Store\n\n# Runtime state (memory, audit, queues) — created at runtime\n.ravel/\n`,
  );
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
