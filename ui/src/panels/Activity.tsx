import { useEffect, useRef } from "react";
import type { AuditEvent, Dashboard, AgentActivity } from "../api";

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function detail(e: AuditEvent): string {
  const d = e.data;
  switch (e.type) {
    case "process.turn":
      return `turn ${d["turn"]} · ${d["done"] ? "done" : `→ ${(d["assignees"] as string[] | undefined)?.join(", ") || "—"}`}`;
    case "task.started":
      return String(d["goal"] ?? "").slice(0, 80);
    case "task.finished":
      return `${d["status"]}${d["summary"] ? ` — ${String(d["summary"]).slice(0, 120)}` : ""}`;
    case "tool.started":
      return `▸ ${d["tool"]}`;
    case "proposal.created":
      return `${d["action"]} (awaiting approval)`;
    case "proposal.executed":
      return `${d["action"]} ✓`;
    case "process.finished":
      return `${d["process"]} · ${d["status"]}`;
    default:
      return "";
  }
}

/** One-line description of what an agent is doing right now. */
export function activityLine(state: string, a?: AgentActivity): { text: string; cls: string } {
  if (a?.waitingOnApproval) return { text: `⏳ waiting on approval${a.currentTool ? ` · ${a.currentTool}` : ""}`, cls: "warn" };
  if (state === "running") {
    if (a?.currentTool) return { text: `▸ ${a.currentTool}`, cls: "good" };
    if (a?.taskGoal) return { text: `▸ ${a.taskGoal.slice(0, 60)}`, cls: "good" };
    return { text: "▸ working…", cls: "good" };
  }
  if (state === "draining") return { text: "draining", cls: "warn" };
  if (state === "killed") return { text: "killed", cls: "bad" };
  return { text: "idle", cls: "muted" };
}

export function ActivityPanel({ events, dash }: { events: AuditEvent[]; dash: Dashboard | null }) {
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    feedRef.current?.scrollTo(0, feedRef.current.scrollHeight);
  }, [events.length]);

  return (
    <div className="cols">
      <div className="panel" style={{ overflow: "auto" }}>
        <h2>Agents</h2>
        <div className="stack">
          {(dash?.agents ?? []).map((a) => {
            const live = activityLine(a.state, a.activity);
            return (
              <div key={a.nodeId} className="card" style={{ margin: 0 }}>
                <div>
                  <b>{a.name}</b> <span className="muted">[{a.role}]</span>
                </div>
                <div className="meta">
                  <span className={live.cls}>{live.text}</span>
                </div>
                <div className="meta muted">
                  {a.tasksRun} task(s) · {fmtUsd(a.usage.usd)}
                </div>
              </div>
            );
          })}
          {!dash?.agents.length && <div className="muted">No agents yet.</div>}
        </div>
      </div>

      <div className="panel" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <h2>Live activity {dash && <span className="muted">· {fmtUsd(dash.totalUsage.usd)} total</span>}</h2>
        <div className="feed" ref={feedRef} style={{ overflow: "auto", flex: 1 }}>
          {events.length === 0 && <div className="muted">Waiting for activity… run a process to see the trace.</div>}
          {events.map((e) => (
            <div className="row" key={e.seq}>
              <span className="t">{e.at.slice(11, 19)}</span>
              <span className="ty">{e.type}</span>
              <span className="muted">{e.nodeId || ""}</span>
              <span>{detail(e)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
