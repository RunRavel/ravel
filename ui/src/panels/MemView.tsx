import { useEffect, useMemo, useState } from "react";
import { api, type MemFile } from "../api";

// ── helpers ──────────────────────────────────────────────────────────────────

export function fmtBytes(n?: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function tryJson(text: string): unknown | undefined {
  const t = text.trim();
  if (!t || !/^[[{]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function cell(v: unknown): { text: string; full: string } {
  if (v === null || v === undefined) return { text: "", full: "" };
  if (typeof v === "object") {
    const full = JSON.stringify(v);
    return { text: full.length > 80 ? full.slice(0, 80) + "…" : full, full };
  }
  const s = String(v);
  return { text: s.length > 120 ? s.slice(0, 120) + "…" : s, full: s };
}

// ── type-aware file rendering ──────────────────────────────────────────────────

function JsonTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = useMemo(() => {
    const seen: string[] = [];
    for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
    return seen;
  }, [rows]);
  const shown = rows.slice(0, 300);
  return (
    <div style={{ overflow: "auto" }}>
      <div className="muted" style={{ marginBottom: 6 }}>{rows.length} item(s){rows.length > 300 ? " · showing first 300" : ""}</div>
      <table className="mem-table">
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => {
                const { text, full } = cell(r[c]);
                return <td key={c} title={full}>{text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyVal({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  return (
    <div className="mem-kv">
      {entries.map(([k, v]) => {
        const { text, full } = cell(v);
        return (
          <div className="mem-kv-row" key={k}>
            <span className="mem-kv-key">{k}</span>
            <span className="mem-kv-val" title={full}>{text}</span>
          </div>
        );
      })}
      {!entries.length && <div className="muted">empty object</div>}
    </div>
  );
}

function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: JSX.Element[] = [];
  let bullets: string[] = [];
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
      p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : <span key={i}>{p}</span>,
    );
  const flush = () => {
    if (bullets.length) {
      out.push(<ul key={`u${out.length}`}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>);
      bullets = [];
    }
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (/^#{1,6}\s/.test(l)) {
      flush();
      const level = l.match(/^#+/)![0].length;
      const txt = l.replace(/^#+\s/, "");
      out.push(level <= 2 ? <h3 key={out.length}>{txt}</h3> : <h4 key={out.length}>{txt}</h4>);
    } else if (/^[-*]\s/.test(l)) {
      bullets.push(l.replace(/^[-*]\s/, ""));
    } else if (l === "") {
      flush();
    } else {
      flush();
      out.push(<p key={out.length} style={{ margin: "4px 0" }}>{inline(l)}</p>);
    }
  }
  flush();
  return <div className="mem-md">{out}</div>;
}

export function MemFileView({ file }: { file: MemFile }) {
  const data = tryJson(file.content);
  if (Array.isArray(data)) {
    const objs = data.filter((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<string, unknown>[];
    if (objs.length === data.length && data.length > 0) return <JsonTable rows={objs} />;
    return (
      <div>
        <div className="muted" style={{ marginBottom: 6 }}>{data.length} item(s)</div>
        {data.length === 0 ? <div className="muted">empty list</div> : <pre className="mem-pre">{JSON.stringify(data, null, 2)}</pre>}
      </div>
    );
  }
  if (data && typeof data === "object") return <KeyVal obj={data as Record<string, unknown>} />;
  if (data !== undefined) return <pre className="mem-pre">{JSON.stringify(data, null, 2)}</pre>;
  return <MarkdownLite text={file.content} />;
}

// ── reusable live tabbed viewer (used by Memory page AND Runs panel) ───────────

/**
 * Controlled tabs over a set of memory file paths, with type-aware rendering and
 * live refresh (re-fetches an open file only when its mtime changes). The parent
 * owns which paths are open and which is active.
 */
export function MemTabs({
  paths,
  active,
  onActivate,
  onClose,
}: {
  paths: string[];
  active: string | null;
  onActivate: (p: string) => void;
  onClose: (p: string) => void;
}) {
  const [files, setFiles] = useState<Record<string, MemFile>>({});

  // Fetch newly-opened files.
  useEffect(() => {
    for (const p of paths) {
      if (!files[p]) api.memFile(p).then((f) => setFiles((s) => ({ ...s, [p]: f }))).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths.join("|")]);

  // Live refresh: re-fetch each open file; update only when mtime actually changed.
  useEffect(() => {
    if (!paths.length) return;
    const tick = () => {
      for (const p of paths) {
        api.memFile(p).then((f) => setFiles((s) => (s[p] && s[p]!.mtimeMs === f.mtimeMs ? s : { ...s, [p]: f }))).catch(() => {});
      }
    };
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, [paths.join("|")]);

  const activeFile = active ? files[active] : null;
  const label = (p: string) => p.split("/").slice(-1)[0]!.replace(/\.md$/, "");

  if (!paths.length) return <div className="muted">Click a file to view it.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div className="mem-tabs">
        {paths.map((p) => (
          <div key={p} className={`mem-tab ${active === p ? "active" : ""}`} onClick={() => onActivate(p)} title={p}>
            <span>{label(p)}</span>
            <span className="mem-tab-x" onClick={(e) => { e.stopPropagation(); onClose(p); }}>×</span>
          </div>
        ))}
      </div>
      {activeFile ? (
        <div style={{ overflow: "auto", flex: 1 }}>
          <div className="muted" style={{ marginBottom: 8 }}>{activeFile.path} · {fmtBytes(activeFile.size)}</div>
          <MemFileView file={activeFile} />
        </div>
      ) : (
        <div className="muted">Loading…</div>
      )}
    </div>
  );
}
