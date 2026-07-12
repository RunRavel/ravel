import { useEffect, useState } from "react";
import { api, type ChatTurn, type Org } from "../api";

export function ChatPanel() {
  const [org, setOrg] = useState<Org | null>(null);
  const [nodeId, setNodeId] = useState<string>("");
  const [log, setLog] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.org().then((o) => {
      setOrg(o);
      if (o.nodes[0]) setNodeId(o.nodes[0].id);
    });
  }, []);

  // Load durable chat history (from the audit trail) whenever the agent changes,
  // so conversations persist across navigation and reloads.
  useEffect(() => {
    if (nodeId === undefined) return;
    api.chatHistory(nodeId).then((r) => setLog(r.turns)).catch(() => setLog([]));
  }, [nodeId]);

  const sel = org?.nodes.find((n) => n.id === nodeId);

  const send = async () => {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    setLog((l) => [...l, { who: "me", text: message }]);
    setBusy(true);
    try {
      const { reply } = await api.chat(nodeId, message);
      setLog((l) => [...l, { who: "agent", text: reply }]);
    } catch (e) {
      setLog((l) => [...l, { who: "agent", text: `error: ${String(e)}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column" }}>
      <h2>
        Chat with{" "}
        <select value={nodeId} onChange={(e) => setNodeId(e.target.value)} style={{ width: "auto", display: "inline-block" }}>
          {org?.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name} [{n.role}]
            </option>
          ))}
        </select>
      </h2>
      {sel && <div className="muted" style={{ marginBottom: 10 }}>{sel.id || "(root)"} · {sel.autonomy}</div>}
      <div className="chat-log">
        {log.map((t, i) => (
          <div key={i} className={`bubble ${t.who}`}>{t.text}</div>
        ))}
        {busy && <div className="bubble agent muted">…thinking</div>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <textarea
          rows={2}
          value={draft}
          placeholder="Message this agent…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
        />
        <button className="primary" disabled={busy} onClick={send}>
          Send
        </button>
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>⌘/Ctrl+Enter to send</div>
    </div>
  );
}
