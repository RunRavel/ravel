// Thin typed client over the Ravel service API (proxied at /api).

export interface OrgNode {
  id: string;
  name: string;
  role: string;
  parentId: string | null;
  childIds: string[];
  autonomy: string;
  model: string | null;
  tools: Array<{ name: string; policy: string }>;
  processCount: number;
}
export interface Org {
  rootId: string;
  version: number;
  nodes: OrgNode[];
  processes: Array<{ name: string; owner: string; path?: string }>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usd: number;
}
export interface AgentActivity {
  taskGoal?: string;
  currentTool?: string;
  waitingOnApproval?: boolean;
  since?: string;
}
export interface AgentMetric {
  nodeId: string;
  name: string;
  role: string;
  state: string;
  tasksRun: number;
  usage: Usage;
  activity?: AgentActivity;
}
export interface Dashboard {
  totalUsage: Usage;
  agents: AgentMetric[];
  processRuns: Array<{ runId: string; process: string; status: string; turns: number; usage: Usage }>;
  pendingProposals: number;
  deadLetters: number;
  eventCount: number;
}

export interface Proposal {
  id: string;
  runId?: string;
  nodeId: string;
  action: string;
  input: unknown;
  rationale?: string;
  status: string;
  createdAt: string;
}

export interface AuditEvent {
  seq: number;
  at: string;
  type: string;
  nodeId?: string;
  runId?: string;
  data: Record<string, unknown>;
}

export interface RunSummary {
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
}

export interface ChatTurn {
  who: "me" | "agent";
  text: string;
  at?: string;
}

export interface ScheduleEntry {
  name: string;
  enabled: boolean;
  mode: "adaptive" | "cron";
  minMinutes: number;
  maxMinutes: number;
  cron?: string;
  maxUsdPerDay?: number;
  spentTodayUsd: number;
  nextRunAt?: number;
  running?: boolean;
  lastRunAt?: number;
  lastRunId?: string;
  lastIntervalMin?: number;
  lastReason?: string;
  pausedForBudget?: boolean;
}
export interface MemNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  mtimeMs?: number;
  children?: MemNode[];
}
export interface MemFile {
  path: string;
  content: string;
  mtimeMs: number;
  size: number;
}
// Relative to the document base ("api/...", no leading slash) so the console
// works at / and mounted under a path prefix (the page URL must end in "/").
async function get<T>(path: string): Promise<T> {
  const r = await fetch(`api${path}`);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json() as Promise<T>;
}
async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok && r.status !== 202) throw new Error(`${method} ${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  org: () => get<Org>("/org"),
  dashboard: () => get<Dashboard>("/dashboard"),
  processes: () => get<{ processes: Array<{ name: string; owner: string }> }>("/processes"),
  proposals: (status = "pending") => get<{ proposals: Proposal[] }>(`/proposals?status=${status}`),
  resolveProposal: (id: string, decision: "approve" | "reject") =>
    send<{ proposal: Proposal }>("POST", `/proposals/${id}`, { decision }),
  chat: (nodeId: string, message: string) => send<{ reply: string }>("POST", "/chat", { nodeId, message }),
  runProcess: (name: string, inputs: Record<string, string>, files: Array<{ name: string; contentBase64: string }>) =>
    send<{ runId: string }>("POST", `/processes/${encodeURIComponent(name)}/run`, { inputs, files }),
  runs: () => get<{ runs: RunSummary[] }>("/runs"),
  runEvents: (runId: string) => get<{ events: AuditEvent[] }>(`/runs/${runId}/events`),
  schedule: () => get<{ processes: ScheduleEntry[] }>("/scheduler"),
  setSchedule: (patch: { name: string } & Partial<Omit<ScheduleEntry, "name" | "spentTodayUsd">>) =>
    send<{ processes: ScheduleEntry[] }>("PUT", "/scheduler", patch),
  removeSchedule: (name: string) =>
    send<{ processes: ScheduleEntry[] }>("DELETE", `/scheduler?name=${encodeURIComponent(name)}`),
  memTree: () => get<{ tree: MemNode[] }>("/mem/tree"),
  memFile: (p: string) => get<MemFile>(`/mem/file?path=${encodeURIComponent(p)}`),
  dismissRun: (runId: string) => send<{ ok: boolean }>("POST", `/runs/${runId}/dismiss`),
  stopRun: (runId: string) => send<{ stopped: boolean; aborted: number }>("POST", `/runs/${runId}/stop`),
  run: (runId: string) => get<{ status: string; error?: string }>(`/runs/${runId}`),
  runFiles: (runId: string) => get<{ files: string[] }>(`/runs/${runId}/files`),
  chatHistory: (nodeId: string) => get<{ turns: ChatTurn[] }>(`/chats?nodeId=${encodeURIComponent(nodeId)}`),
  runFile: async (runId: string, name: string): Promise<string> => {
    const r = await fetch(`api/runs/${runId}/files/${encodeURIComponent(name)}`);
    return r.text();
  },
  readFile: (path: string) => get<{ content?: string; error?: string }>(`/files?path=${encodeURIComponent(path)}`),
  writeFile: (path: string, content: string) =>
    send<{ ok: boolean; diagnostics: Array<{ where: string; message: string }> }>("PUT", "/files", { path, content }),
  validate: () => get<{ ok: boolean; diagnostics: Array<{ where: string; message: string }> }>("/validate"),
  secretKeys: (nodeId: string) => get<{ keys: string[] }>(`/secrets?nodeId=${encodeURIComponent(nodeId)}`),
  setSecret: (nodeId: string, key: string, value: string) =>
    send<{ keys: string[] }>("PUT", "/secrets", { nodeId, action: "set", key, value }),
  deleteSecret: (nodeId: string, key: string) =>
    send<{ keys: string[] }>("PUT", "/secrets", { nodeId, action: "delete", key }),
};

/** Subscribe to the live SSE stream. Returns an unsubscribe fn. */
export function subscribe(handlers: {
  onAudit?: (e: AuditEvent) => void;
  onProposal?: (p: Proposal) => void;
}): () => void {
  const es = new EventSource("api/events");
  if (handlers.onAudit) es.addEventListener("audit", (m) => handlers.onAudit!(JSON.parse((m as MessageEvent).data)));
  if (handlers.onProposal) es.addEventListener("proposal", (m) => handlers.onProposal!(JSON.parse((m as MessageEvent).data)));
  return () => es.close();
}
