import { useEffect, useState } from "react";
import { api, subscribe, type AuditEvent, type Dashboard } from "./api";
import { OrgPanel } from "./panels/Org";
import { ActivityPanel } from "./panels/Activity";
import { ProposalsPanel } from "./panels/Proposals";
import { ChatPanel } from "./panels/Chat";
import { RunsPanel } from "./panels/Runs";
import { MemoryPanel } from "./panels/Memory";

type Tab = "activity" | "proposals" | "memory" | "org" | "chat" | "runs";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "activity", label: "Activity" },
  { id: "proposals", label: "Proposals" },
  { id: "memory", label: "Memory" },
  { id: "org", label: "Org / Config" },
  { id: "chat", label: "Chat" },
  { id: "runs", label: "Runs" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("activity");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [dash, setDash] = useState<Dashboard | null>(null);
  // Bumped on any proposal SSE event so panels can refetch.
  const [proposalTick, setProposalTick] = useState(0);

  useEffect(() => {
    return subscribe({
      onAudit: (e) => setEvents((prev) => [...prev.slice(-499), e]),
      onProposal: () => setProposalTick((n) => n + 1),
    });
  }, []);

  useEffect(() => {
    const tickFetch = () => api.dashboard().then(setDash).catch(() => {});
    tickFetch();
    const id = setInterval(tickFetch, 3000);
    return () => clearInterval(id);
  }, [events.length, proposalTick]);

  const pending = dash?.pendingProposals ?? 0;

  return (
    <div className="app">
      <div className="topbar">
        <h1>Ravel</h1>
        {dash && (
          <>
            <span className="stat">
              spend <b>${dash.totalUsage.usd.toFixed(3)}</b>
            </span>
            <span className="stat">
              agents <b>{dash.agents.length}</b>
            </span>
            <span className="stat">
              events <b>{dash.eventCount}</b>
            </span>
            {dash.deadLetters > 0 && <span className="stat bad">dead-letters {dash.deadLetters}</span>}
          </>
        )}
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "proposals" && pending > 0 && <span className="badge">{pending}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="main">
        {tab === "activity" && <ActivityPanel events={events} dash={dash} />}
        {tab === "proposals" && <ProposalsPanel tick={proposalTick} />}
        {tab === "memory" && <MemoryPanel />}
        {tab === "org" && <OrgPanel />}
        {tab === "chat" && <ChatPanel />}
        {tab === "runs" && <RunsPanel />}
      </div>
    </div>
  );
}
