import { useCallback, useEffect, useState } from "react";
import { api, type MemNode } from "../api";
import { MemTabs, fmtBytes } from "./MemView";

function Tree({
  nodes,
  depth,
  active,
  collapsed,
  onToggle,
  onOpen,
}: {
  nodes: MemNode[];
  depth: number;
  active: string | null;
  collapsed: Set<string>;
  onToggle: (p: string) => void;
  onOpen: (p: string) => void;
}) {
  return (
    <>
      {nodes.map((n) =>
        n.type === "dir" ? (
          <div key={n.path}>
            <div className="tree-node" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onToggle(n.path)}>
              <span className="muted">{collapsed.has(n.path) ? "▸" : "▾"}</span> {n.name}/
            </div>
            {!collapsed.has(n.path) && n.children && (
              <Tree nodes={n.children} depth={depth + 1} active={active} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />
            )}
          </div>
        ) : (
          <div
            key={n.path}
            className={`tree-node ${active === n.path ? "sel" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onOpen(n.path)}
            title={`${fmtBytes(n.size)} · ${n.path}`}
          >
            {n.name.replace(/\.md$/, "")}
          </div>
        ),
      )}
    </>
  );
}

export function MemoryPanel() {
  const [tree, setTree] = useState<MemNode[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [order, setOrder] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const refreshTree = useCallback(() => api.memTree().then((r) => setTree(r.tree)).catch(() => {}), []);
  useEffect(() => {
    refreshTree();
    const id = setInterval(refreshTree, 3000);
    return () => clearInterval(id);
  }, [refreshTree]);

  const open = (p: string) => {
    setActive(p);
    setOrder((o) => (o.includes(p) ? o : [...o, p]));
  };
  const close = (p: string) => {
    setOrder((o) => o.filter((x) => x !== p));
    setActive((a) => (a === p ? order.filter((x) => x !== p).slice(-1)[0] ?? null : a));
  };
  const toggle = (p: string) => setCollapsed((c) => { const n = new Set(c); n.has(p) ? n.delete(p) : n.add(p); return n; });

  return (
    <div className="cols">
      <div className="panel" style={{ overflow: "auto", maxWidth: 320 }}>
        <h2>Memory</h2>
        <div className="muted" style={{ marginBottom: 8 }}>The on-disk memory tree (read-only).</div>
        {tree.length === 0 && <div className="muted">No memory yet — run a process.</div>}
        <Tree nodes={tree} depth={0} active={active} collapsed={collapsed} onToggle={toggle} onOpen={open} />
      </div>
      <div className="panel" style={{ overflow: "auto", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <MemTabs paths={order} active={active} onActivate={setActive} onClose={close} />
      </div>
    </div>
  );
}
