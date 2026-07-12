import { useEffect, useState } from "react";
import { api, type RunSummary, type AuditEvent, type MemNode } from "../api";
import { MemTabs } from "./MemView";

/** Files in the team's shared (team-scope) memory — `memory/team/<owner>/*`. */
function teamFilesOf(tree: MemNode[], owner: string): MemNode[] {
  const teamDir = tree.find((n) => n.type === "dir" && n.name === "team");
  const ownerDir = teamDir?.children?.find((n) => n.type === "dir" && n.name === (owner || "_root"));
  return (ownerDir?.children ?? []).filter((n) => n.type === "file");
}

async function fileToBase64(file: File): Promise<{ name: string; contentBase64: string }> {
  const buf = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return { name: file.name, contentBase64: btoa(binary) };
}

function statusClass(s: string): string {
  if (s.startsWith("completed")) return "good";
  if (s.startsWith("failed") || s.startsWith("budget") || s === "interrupted" || s === "stopped") return "bad";
  return "warn";
}

/** One-line summary of a per-run audit event for the activity feed. */
function feedLine(e: AuditEvent): string | null {
  const d = e.data;
  switch (e.type) {
    case "task.started":
      return `started: ${String(d["goal"] ?? "").slice(0, 70)}`;
    case "task.finished":
      return `finished (${d["status"]})${d["summary"] ? ` — ${String(d["summary"])}` : ""}`;
    case "tool.started":
      return `▸ ${d["tool"]}`;
    case "proposal.created":
      return `proposed ${d["action"]} — awaiting approval`;
    case "proposal.executed":
      return `${d["action"]} ✓ approved`;
    case "process.turn":
      return `turn ${d["turn"]}${d["done"] ? " · done" : ` → ${(d["assignees"] as string[] | undefined)?.join(", ") || "—"}`}`;
    case "process.finished":
      return `process ${d["status"]}`;
    default:
      return null;
  }
}

function inputsToText(inputs?: Record<string, unknown>): string {
  if (!inputs) return "";
  return Object.entries(inputs)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
}

export function RunsPanel() {
  const [processes, setProcesses] = useState<Array<{ name: string }>>([]);
  const [name, setName] = useState("");
  const [inputsText, setInputsText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [viewing, setViewing] = useState<{ name: string; content: string } | null>(null);
  const [feed, setFeed] = useState<AuditEvent[]>([]);
  const [teamFiles, setTeamFiles] = useState<MemNode[]>([]);
  const [memOpen, setMemOpen] = useState<string[]>([]);
  const [memActive, setMemActive] = useState<string | null>(null);

  useEffect(() => {
    api.processes().then((r) => {
      setProcesses(r.processes);
      if (r.processes[0]) setName(r.processes[0].name);
    });
  }, []);

  // Poll the full run list (live + past) — survives navigating away and back.
  useEffect(() => {
    let alive = true;
    const tick = () => api.runs().then((r) => alive && setRuns(r.runs)).catch(() => {});
    void tick();
    const id = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Poll the selected run's artifacts.
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    const tick = () => api.runFiles(selected).then((f) => alive && setArtifacts(f.files)).catch(() => {});
    void tick();
    const id = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [selected]);

  // Poll the selected run's per-agent activity feed (audit events for this run).
  useEffect(() => {
    if (!selected) {
      setFeed([]);
      return;
    }
    let alive = true;
    const tick = () => api.runEvents(selected).then((r) => alive && setFeed(r.events)).catch(() => {});
    void tick();
    const id = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [selected]);

  const current = runs.find((r) => r.runId === selected) ?? null;
  const teamScope = current?.owner ?? null;

  // Reset open memory tabs when switching runs.
  useEffect(() => { setMemOpen([]); setMemActive(null); }, [selected]);

  // Poll the selected run's team shared memory (file list); MemTabs handles file content + live updates.
  useEffect(() => {
    if (teamScope === null) { setTeamFiles([]); return; }
    let alive = true;
    const tick = () => api.memTree().then((r) => alive && setTeamFiles(teamFilesOf(r.tree, teamScope))).catch(() => {});
    void tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [teamScope]);

  const openMem = (p: string) => { setMemActive(p); setMemOpen((o) => (o.includes(p) ? o : [...o, p])); };
  const closeMem = (p: string) => {
    setMemOpen((o) => o.filter((x) => x !== p));
    setMemActive((a) => (a === p ? memOpen.filter((x) => x !== p).slice(-1)[0] ?? null : a));
  };

  const launch = async () => {
    const inputs: Record<string, string> = {};
    for (const line of inputsText.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) inputs[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    const encoded = await Promise.all(files.map(fileToBase64));
    const { runId } = await api.runProcess(name, inputs, encoded);
    setSelected(runId);
    setArtifacts([]);
    setViewing(null);
    void api.runs().then((r) => setRuns(r.runs));
  };

  const prefillFromRun = (r: RunSummary) => {
    setName(r.process);
    setInputsText(inputsToText(r.inputs));
    setFiles([]);
    setSelected(null);
    setViewing(null);
  };

  const dismiss = async (runId: string) => {
    await api.dismissRun(runId);
    if (selected === runId) setSelected(null);
    void api.runs().then((r) => setRuns(r.runs));
  };

  const stop = async (runId: string) => {
    await api.stopRun(runId).catch(() => {});
    void api.runs().then((r) => setRuns(r.runs));
  };

  return (
    <div
      className="cols"
      style={memOpen.length ? { gridTemplateColumns: "260px minmax(0, 1fr) minmax(0, 1.1fr)" } : undefined}
    >
      <div className="panel" style={{ overflow: "auto" }}>
        <h2>Launch a process</h2>
        <div className="stack">
          <select value={name} onChange={(e) => setName(e.target.value)}>
            {processes.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <div>
            <div className="muted" style={{ marginBottom: 4 }}>Inputs (key=value per line)</div>
            <textarea rows={3} value={inputsText} onChange={(e) => setInputsText(e.target.value)} placeholder={"sourceLang=en\ntargetLang=hebrew"} />
          </div>
          <div>
            <div className="muted" style={{ marginBottom: 4 }}>Source files</div>
            <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          </div>
          <button className="primary" onClick={launch} disabled={!name}>
            Run
          </button>
        </div>

        <h2 style={{ marginTop: 18 }}>Runs</h2>
        {runs.length === 0 && <div className="muted">No runs yet.</div>}
        <div className="stack">
          {runs.map((r) => (
            <div key={r.runId} className={`tree-node ${selected === r.runId ? "sel" : ""}`} onClick={() => { setSelected(r.runId); setViewing(null); }}>
              <div>{r.process}</div>
              <div className="meta">
                <span className={statusClass(r.status)}>{r.status}</span> · {r.startedAt.slice(11, 19)}
                {r.usd !== undefined ? ` · $${r.usd.toFixed(3)}` : ""}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel" style={{ overflow: "auto" }}>
        {!current && <div className="muted">Select a run to see its status and deliverables. Approvals queue in the Proposals tab.</div>}
        {current && (
          <>
            <h2>
              {current.process} <span className="muted">· {current.runId}</span>
            </h2>
            <div className="kv" style={{ marginBottom: 12 }}>
              <span className="k">Status</span>
              <span className={statusClass(current.status)}>{current.status}{current.error ? `: ${current.error}` : ""}</span>
              <span className="k">Turns</span>
              <span>{current.turns ?? "—"}</span>
              <span className="k">Cost</span>
              <span>{current.usd !== undefined ? `$${current.usd.toFixed(4)}` : "—"}</span>
            </div>
            <div className="row-actions" style={{ marginBottom: 12 }}>
              {current.status === "running" && (
                <button className="danger" onClick={() => stop(current.runId)}>Stop</button>
              )}
              <button className="primary" onClick={() => prefillFromRun(current)}>Re-run</button>
              {current.status !== "running" && (
                <button className="danger" onClick={() => dismiss(current.runId)}>Dismiss</button>
              )}
            </div>
            {current.status === "interrupted" && (
              <div className="warn" style={{ marginBottom: 12 }}>
                This run was interrupted by a server restart — it isn't actually running. Resume isn't supported; use
                Re-run to start it fresh (re-attach any source files), or Dismiss to clear it.
              </div>
            )}
            <h2>Activity</h2>
            {feed.length === 0 && <div className="muted">No activity recorded for this run yet.</div>}
            <div className="feed" style={{ maxHeight: 240, overflow: "auto", marginBottom: 12 }}>
              {feed.map((e) => {
                const line = feedLine(e);
                if (!line) return null;
                return (
                  <div className="row" key={e.seq}>
                    <span className="t">{e.at.slice(11, 19)}</span>
                    <span className="muted">{e.nodeId || "(root)"}</span>
                    <span>{line}</span>
                  </div>
                );
              })}
            </div>

            <h2>Deliverables (shared workspace)</h2>
            {artifacts.length === 0 && <div className="muted">No files yet.</div>}
            <div className="stack">
              {artifacts.map((f) => (
                <div key={f} className="tree-node" onClick={async () => setViewing({ name: f, content: await api.runFile(current.runId, f) })}>
                  {f}
                </div>
              ))}
            </div>
            {viewing && (
              <div className="card" style={{ marginTop: 12 }}>
                <b>{viewing.name}</b>
                <pre>{viewing.content}</pre>
              </div>
            )}

            <h2 style={{ marginTop: 18 }}>Team memory <span className="muted">· {current.owner || "root"}</span></h2>
            {teamFiles.length === 0 && <div className="muted">No shared memory yet for this team.</div>}
            <div className="stack">
              {teamFiles.map((f) => (
                <div
                  key={f.path}
                  className={`tree-node ${memActive === f.path ? "sel" : ""}`}
                  onClick={() => openMem(f.path)}
                >
                  {f.name.replace(/\.md$/, "")}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {memOpen.length > 0 && (
        <div className="panel" style={{ overflow: "auto", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <MemTabs paths={memOpen} active={memActive} onActivate={setMemActive} onClose={closeMem} />
        </div>
      )}
    </div>
  );
}
