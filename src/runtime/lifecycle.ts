import type { RegistryNode, RegistrySnapshot } from "../control-plane/registry.js";
import type { ModelTier } from "../schemas/common.js";
import { AgentRuntime, type AgentRuntimeDeps } from "./agent.js";
import type { AuditSink } from "../trust/audit.js";

export interface LifecycleDeps extends AgentRuntimeDeps {
  audit: AuditSink;
}

/** A node id is a manager-altitude node if it has children. */
function tierForNode(node: RegistryNode): ModelTier {
  return node.childIds.length > 0 ? "opus" : "sonnet";
}

/** Stable fingerprint of the parts of a node that affect runtime behavior. */
function fingerprint(node: RegistryNode): string {
  return JSON.stringify({ spec: node.spec, tools: node.tools });
}

/**
 * Owns the live set of agent runtimes and reconciles it against registry
 * snapshots. Reconciliation is a diff:
 * - new node            → spawn a runtime
 * - removed node        → drain it, then drop it (in-flight work finishes)
 * - changed node config → swap config in place (no disruption to a running task)
 *
 * Editing a folder thus flows: watcher compiles a snapshot → lifecycle diffs →
 * agents are spawned/drained/updated deliberately. Nothing mutates a running
 * agent directly.
 */
export class Lifecycle {
  private readonly agents = new Map<string, AgentRuntime>();
  private readonly fingerprints = new Map<string, string>();
  private appliedVersion = -1;

  constructor(private readonly deps: LifecycleDeps) {}

  get(nodeId: string): AgentRuntime | undefined {
    return this.agents.get(nodeId);
  }

  all(): AgentRuntime[] {
    return [...this.agents.values()];
  }

  version(): number {
    return this.appliedVersion;
  }

  async applySnapshot(snapshot: RegistrySnapshot): Promise<void> {
    const next = new Set(snapshot.nodes.keys());

    // Removed nodes: drain and drop.
    for (const id of [...this.agents.keys()]) {
      if (!next.has(id)) {
        const agent = this.agents.get(id)!;
        agent.drain();
        this.agents.delete(id);
        this.fingerprints.delete(id);
        await this.deps.audit.append("agent.drained", { nodeId: id, data: {} });
      }
    }

    // Added or changed nodes.
    for (const node of snapshot.nodes.values()) {
      const existing = this.agents.get(node.id);
      const fp = fingerprint(node);
      if (!existing) {
        const agent = new AgentRuntime(node, this.deps, tierForNode(node));
        this.agents.set(node.id, agent);
        this.fingerprints.set(node.id, fp);
        await this.deps.audit.append("agent.spawned", {
          nodeId: node.id,
          data: { name: node.spec.name, role: node.spec.role },
        });
      } else if (this.fingerprints.get(node.id) !== fp) {
        existing.updateNode(node);
        this.fingerprints.set(node.id, fp);
        await this.deps.audit.append("agent.updated", { nodeId: node.id, data: {} });
      }
    }

    this.appliedVersion = snapshot.version;
  }
}
