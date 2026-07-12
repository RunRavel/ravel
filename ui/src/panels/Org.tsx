import { useEffect, useState } from "react";
import { api, type Org, type OrgNode, type AgentMetric, type ScheduleEntry } from "../api";
import { activityLine } from "./Activity";

export function OrgPanel() {
  const [org, setOrg] = useState<Org | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [selProc, setSelProc] = useState<string | null>(null);
  const [agents, setAgents] = useState<Record<string, AgentMetric>>({});

  const loadOrg = () => api.org().then(setOrg).catch(() => {});
  useEffect(() => {
    loadOrg();
  }, []);

  // Poll the dashboard so the tree reflects each agent's live state/activity.
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .dashboard()
        .then((d) => alive && setAgents(Object.fromEntries(d.agents.map((a) => [a.nodeId, a]))))
        .catch(() => {});
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const node = org?.nodes.find((n) => n.id === sel) ?? null;
  const proc = org?.processes.find((p) => p.path === selProc) ?? null;

  return (
    <div className="cols">
      <div className="panel" style={{ overflow: "auto" }}>
        <h2>Org</h2>
        {org?.nodes.map((n) => {
          const m = agents[n.id];
          const live = m ? activityLine(m.state, m.activity) : null;
          return (
            <div
              key={n.id}
              className={`tree-node ${sel === n.id ? "sel" : ""}`}
              style={{ paddingLeft: 8 + depth(n.id) * 16 }}
              onClick={() => { setSel(n.id); setSelProc(null); }}
            >
              {n.name} <span className="role">[{n.role}]</span>
              {live && live.cls !== "muted" && (
                <div className="meta">
                  <span className={live.cls}>{live.text}</span>
                </div>
              )}
            </div>
          );
        })}
        <h2 style={{ marginTop: 16 }}>Processes</h2>
        {org?.processes.map((p) => (
          <div
            key={p.path ?? p.name}
            className={`tree-node ${selProc === p.path ? "sel" : ""}`}
            onClick={() => { if (p.path) { setSelProc(p.path); setSel(null); } }}
            style={p.path ? undefined : { cursor: "default" }}
          >
            {p.name} <span className="role">→ {p.owner || "(root)"}</span>
          </div>
        ))}
      </div>

      {proc?.path ? (
        <ProcessEditor key={proc.path} path={proc.path} name={proc.name} onSaved={loadOrg} />
      ) : node ? (
        <NodeEditor node={node} onSaved={loadOrg} />
      ) : (
        <div className="panel">Select an agent or process to view and edit it.</div>
      )}
    </div>
  );
}

function ProcessEditor({ path, name, onSaved }: { path: string; name: string; onSaved: () => void }) {
  const [text, setText] = useState("");
  const [diagnostics, setDiagnostics] = useState<Array<{ where: string; message: string }>>([]);
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    setStatus("");
    setDiagnostics([]);
    api.readFile(path).then((r) => setText(r.content ?? ""));
  }, [path]);

  const save = async () => {
    const r = await api.writeFile(path, text);
    setDiagnostics(r.diagnostics);
    setStatus(r.ok ? "Saved — recompiled cleanly. Live org hot-reloaded." : "Saved, but the org has validation errors:");
    if (r.ok) onSaved();
  };

  return (
    <div className="panel" style={{ overflow: "auto" }}>
      <h2>
        {name} <span className="muted">· {path}</span>
      </h2>
      <div className="muted" style={{ marginBottom: 4 }}>Process playbook (frontmatter: trigger, owner, participants, budget; body = steps)</div>
      <textarea rows={20} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row-actions">
        <button className="primary" onClick={save}>Save process</button>
      </div>
      {status && <div className={diagnostics.length ? "bad" : "good"}>{status}</div>}
      {diagnostics.map((d, i) => (
        <div key={i} className="diag">
          {d.where}: {d.message}
        </div>
      ))}
      <AutomationCard processName={name} />
    </div>
  );
}

function fmtNext(e: ScheduleEntry): string {
  if (!e.enabled) return "off";
  if (e.running) return "running now";
  if (e.pausedForBudget) return "paused — daily $ cap reached";
  if (!e.nextRunAt) return "due";
  const ms = e.nextRunAt - Date.now();
  if (ms <= 0) return "due now";
  const min = Math.round(ms / 60000);
  return min < 60 ? `next in ${min}m` : `next in ${(min / 60).toFixed(1)}h`;
}

const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Daily 09:00", cron: "0 9 * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Weekdays 08:00", cron: "0 8 * * 1-5" },
  { label: "Every 15 min", cron: "*/15 * * * *" },
];

/**
 * Per-process automation control (lives in Org/Config). Off | Adaptive (self-pacing
 * min/max) | Cron (fixed schedule) + an optional daily $ safety cap.
 */
function AutomationCard({ processName }: { processName: string }) {
  const [entry, setEntry] = useState<ScheduleEntry | null>(null);
  const [mode, setMode] = useState<"off" | "adaptive" | "cron">("off");
  const [min, setMin] = useState("15");
  const [max, setMax] = useState("360");
  const [cron, setCron] = useState("0 9 * * *");
  const [cap, setCap] = useState("");
  const [err, setErr] = useState("");

  // Hydrate the editable fields ONCE per process; then poll only live status so an
  // in-progress selection is never clobbered by the interval.
  useEffect(() => {
    let alive = true;
    api.schedule().then((r) => {
      if (!alive) return;
      const e = r.processes.find((p) => p.name === processName) ?? null;
      setEntry(e);
      setMode(e && e.enabled ? e.mode : "off");
      setMin(String(e?.minMinutes ?? 15));
      setMax(String(e?.maxMinutes ?? 360));
      if (e?.cron) setCron(e.cron);
      setCap(e?.maxUsdPerDay !== undefined ? String(e.maxUsdPerDay) : "");
    }).catch(() => {});
    const poll = () => api.schedule().then((r) => alive && setEntry(r.processes.find((p) => p.name === processName) ?? null)).catch(() => {});
    const id = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [processName]);

  const save = async () => {
    setErr("");
    if (mode === "off") {
      await api.setSchedule({ name: processName, enabled: false }).then(setFrom).catch(() => setErr("save failed"));
      return;
    }
    const patch = {
      name: processName,
      enabled: true,
      mode,
      minMinutes: Number(min),
      maxMinutes: Number(max),
      ...(mode === "cron" ? { cron } : {}),
      ...(cap.trim() ? { maxUsdPerDay: Number(cap) } : {}),
    } as const;
    try {
      const r = await api.setSchedule(patch);
      setFrom(r);
    } catch {
      setErr("Invalid — check the cron expression (5 fields: min hour day month weekday).");
    }
  };
  const setFrom = (r: { processes: ScheduleEntry[] }) => setEntry(r.processes.find((p) => p.name === processName) ?? null);

  return (
    <div style={{ marginTop: 16, borderTop: "1px solid var(--border, #333)", paddingTop: 12, maxWidth: 460 }}>
      <div className="muted" style={{ marginBottom: 6 }}>Automation — how this process launches on its own</div>
      <div className="row" style={{ gap: 12, marginBottom: 8 }}>
        {(["off", "adaptive", "cron"] as const).map((mo) => (
          <label key={mo} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input type="radio" name={`mode-${processName}`} checked={mode === mo} onChange={() => setMode(mo)} />
            <span style={{ textTransform: "capitalize" }}>{mo}</span>
          </label>
        ))}
        {entry && <span className={entry.enabled ? "good" : "muted"} style={{ marginLeft: "auto" }}>{fmtNext(entry)}{entry.lastReason ? ` · ${entry.lastReason}` : ""}</span>}
      </div>

      {mode === "adaptive" && (
        <>
          <div className="muted" style={{ marginBottom: 6 }}>The owner orchestrator paces itself; you set the bounds.</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <label className="muted">min interval (min)<input value={min} onChange={(e) => setMin(e.target.value)} inputMode="numeric" /></label>
            <label className="muted">max interval (min)<input value={max} onChange={(e) => setMax(e.target.value)} inputMode="numeric" /></label>
          </div>
        </>
      )}
      {mode === "cron" && (
        <>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
            {CRON_PRESETS.map((p) => (
              <button key={p.cron} onClick={() => setCron(p.cron)} className={cron === p.cron ? "active" : ""}>{p.label}</button>
            ))}
          </div>
          <label className="muted">cron (min hour day month weekday)<input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" /></label>
        </>
      )}
      {mode !== "off" && (
        <label className="muted" style={{ display: "block", marginTop: 6 }}>
          daily $ cap (safety — pauses when 24h spend hits it)
          <input value={cap} onChange={(e) => setCap(e.target.value)} placeholder="none" inputMode="numeric" />
        </label>
      )}
      {mode !== "off" && entry?.enabled && <div className="muted" style={{ marginTop: 6 }}>spent 24h: ${entry.spentTodayUsd.toFixed(2)}{entry.maxUsdPerDay ? ` / ${entry.maxUsdPerDay}` : ""}</div>}

      <div className="row-actions" style={{ marginTop: 8 }}>
        <button className="primary" onClick={save}>Save automation</button>
        {entry && <button className="danger" onClick={() => api.removeSchedule(processName).then(() => { setEntry(null); setMode("off"); }).catch(() => {})}>Remove</button>}
      </div>
      {err && <div className="bad">{err}</div>}
    </div>
  );
}

function depth(id: string): number {
  return id === "" ? 0 : id.split("/").length;
}

function NodeEditor({ node, onSaved }: { node: OrgNode; onSaved: () => void }) {
  const agentPath = node.id ? `${node.id}/agent.md` : "agent.md";
  const toolsPath = node.id ? `${node.id}/tools.json` : "tools.json";
  const [agentMd, setAgentMd] = useState("");
  const [toolsJson, setToolsJson] = useState("");
  const [diagnostics, setDiagnostics] = useState<Array<{ where: string; message: string }>>([]);
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    setStatus("");
    setDiagnostics([]);
    api.readFile(agentPath).then((r) => setAgentMd(r.content ?? ""));
    api.readFile(toolsPath).then((r) => setToolsJson(r.content ?? ""));
  }, [node.id]);

  const save = async (path: string, content: string) => {
    const r = await api.writeFile(path, content);
    setDiagnostics(r.diagnostics);
    setStatus(r.ok ? "Saved — recompiled cleanly. Live org hot-reloaded." : "Saved, but the org has validation errors:");
    if (r.ok) onSaved();
  };

  return (
    <div className="panel" style={{ overflow: "auto" }}>
      <h2>
        {node.name} <span className="muted">· {node.id || "(root)"} · {node.autonomy} · {node.model ?? "default model"}</span>
      </h2>

      <div className="stack">
        <div>
          <div className="muted" style={{ marginBottom: 4 }}>{agentPath} (system prompt + frontmatter)</div>
          <textarea rows={12} value={agentMd} onChange={(e) => setAgentMd(e.target.value)} />
          <div className="row-actions">
            <button className="primary" onClick={() => save(agentPath, agentMd)}>Save agent.md</button>
          </div>
        </div>
        <div>
          <div className="muted" style={{ marginBottom: 4 }}>{toolsPath} (tools + permission policy)</div>
          <textarea rows={8} value={toolsJson} onChange={(e) => setToolsJson(e.target.value)} />
          <div className="row-actions">
            <button className="primary" onClick={() => save(toolsPath, toolsJson)}>Save tools.json</button>
          </div>
        </div>

        {status && <div className={diagnostics.length ? "bad" : "good"}>{status}</div>}
        {diagnostics.map((d, i) => (
          <div key={i} className="diag">
            {d.where}: {d.message}
          </div>
        ))}

        <SecretsEditor nodeId={node.id} />
      </div>
    </div>
  );
}

/**
 * Per-agent credentials (a `.env` in the agent folder). Masked: we only ever show
 * which keys exist; values are write-only and never returned by the API.
 */
function SecretsEditor({ nodeId }: { nodeId: string }) {
  const [keys, setKeys] = useState<string[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [err, setErr] = useState("");

  const refresh = () => api.secretKeys(nodeId).then((r) => setKeys(r.keys)).catch(() => {});
  useEffect(() => {
    setNewKey("");
    setNewValue("");
    setErr("");
    refresh();
  }, [nodeId]);

  const add = async () => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(newKey)) return setErr("Key must be A–Z, 0–9, _ (e.g. SERVICE_KEY)");
    setErr("");
    await api.setSecret(nodeId, newKey, newValue).then((r) => setKeys(r.keys)).catch(() => setErr("save failed"));
    setNewKey("");
    setNewValue("");
  };
  const remove = async (k: string) => {
    await api.deleteSecret(nodeId, k).then((r) => setKeys(r.keys)).catch(() => {});
  };

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--border, #333)", paddingTop: 12 }}>
      <div className="muted" style={{ marginBottom: 4 }}>
        Credentials — <code>{nodeId ? `${nodeId}/.env` : ".env"}</code> (values masked; reference as <code>${"{KEY}"}</code> in tools.json)
      </div>
      <div className="stack">
        {keys.map((k) => (
          <div key={k} className="row" style={{ alignItems: "center", gap: 8 }}>
            <code>{k}</code> <span className="muted">= ••••••••</span>
            <button className="danger" onClick={() => remove(k)}>Delete</button>
          </div>
        ))}
        {!keys.length && <div className="muted">No keys set for this agent.</div>}
        <div className="row" style={{ gap: 8 }}>
          <input placeholder="KEY" value={newKey} onChange={(e) => setNewKey(e.target.value.toUpperCase())} />
          <input type="password" placeholder="value" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
          <button className="primary" onClick={add} disabled={!newKey}>Set</button>
        </div>
        {err && <div className="bad">{err}</div>}
      </div>
    </div>
  );
}
