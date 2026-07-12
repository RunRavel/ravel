import { useCallback, useEffect, useState } from "react";
import { api, type Proposal } from "../api";

export function ProposalsPanel({ tick }: { tick: number }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.proposals("pending").then((r) => setProposals(r.proposals)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, tick]);

  const resolve = async (id: string, decision: "approve" | "reject") => {
    setBusy(id);
    try {
      await api.resolveProposal(id, decision);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const resolveAll = async (decision: "approve" | "reject") => {
    for (const p of proposals) await resolve(p.id, decision);
  };

  return (
    <div className="panel">
      <h2>
        Approval inbox · {proposals.length} pending
        {proposals.length > 0 && (
          <span style={{ float: "right" }}>
            <button className="primary" onClick={() => resolveAll("approve")}>
              Approve all
            </button>{" "}
            <button className="danger" onClick={() => resolveAll("reject")}>
              Reject all
            </button>
          </span>
        )}
      </h2>
      {proposals.length === 0 && <div className="muted">Nothing awaiting approval. Agents keep working; consequential actions queue here.</div>}
      <div className="stack">
        {proposals.map((p) => (
          <div key={p.id} className="card">
            <div>
              <b>{p.action}</b> <span className="meta">· {p.nodeId || "(root)"} {p.runId ? `· ${p.runId}` : ""}</span>
            </div>
            {p.rationale && <div className="meta">why: {p.rationale}</div>}
            <pre>{JSON.stringify(p.input, null, 2)}</pre>
            <div className="row-actions">
              <button className="primary" disabled={busy === p.id} onClick={() => resolve(p.id, "approve")}>
                Approve
              </button>
              <button className="danger" disabled={busy === p.id} onClick={() => resolve(p.id, "reject")}>
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
