import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RegistrySnapshot } from "../control-plane/registry.js";
import type { AuditSink } from "../trust/audit.js";
import { isPluginDefinition, type PluginDefinition } from "./types.js";

/**
 * Loads team plugins (a `plugin.ts` default-exporting `definePlugin({...})`) and
 * scopes them by node. Plugins run **in-process, unsandboxed** — they are the
 * operator's own folders, same trust as `agent.md`.
 *
 * v1 cache rule: a node's plugin is imported once and cached. Editing
 * `agent.md`/`tools.json`/`processes` still hot-reloads, but changing plugin CODE
 * needs a `serve` restart (the JS module cache won't re-execute a re-import).
 * Newly-ADDED plugin nodes are picked up on the next snapshot.
 *
 * A plugin that throws on import or fails validation is audited (`plugin.load_failed`)
 * and skipped — its team's agents still run, just without those tools.
 */
export class PluginRegistry {
  /** Plugins keyed by the node that DECLARES them (owning node only). */
  private readonly byNode = new Map<string, PluginDefinition>();
  /** node id → parent id, from the latest snapshot (for plugin inheritance). */
  private readonly parent = new Map<string, string | null>();
  /** Node ids we've already attempted to import (load-once; code change → restart). */
  private readonly attempted = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly audit: AuditSink,
  ) {}

  /**
   * The plugin governing a node: its own if declared, else the nearest ancestor's
   * (a team-root `plugin.ts` serves all descendant agents). Grants in each agent's
   * `tools.json` still decide which of the plugin's tools that agent may call.
   */
  forNode(nodeId: string): PluginDefinition | undefined {
    let cur: string | undefined = nodeId;
    while (cur !== undefined) {
      const own = this.byNode.get(cur);
      if (own) return own;
      cur = this.parent.get(cur) ?? undefined;
    }
    return undefined;
  }

  /**
   * Owning nodes only (one entry per declared plugin) — so executor actions are
   * registered once, never duplicated across inheriting descendants.
   */
  all(): Array<{ nodeId: string; plugin: PluginDefinition }> {
    return [...this.byNode.entries()].map(([nodeId, plugin]) => ({ nodeId, plugin }));
  }

  /**
   * Import any not-yet-loaded plugins declared in the snapshot. Idempotent: each
   * node is attempted at most once for the life of the process. Also refreshes the
   * parent map so inheritance resolves against the current tree.
   */
  async syncFromSnapshot(snapshot: RegistrySnapshot): Promise<void> {
    for (const node of snapshot.nodes.values()) this.parent.set(node.id, node.parentId);
    for (const node of snapshot.nodes.values()) {
      if (!node.pluginPath || this.attempted.has(node.id)) continue;
      this.attempted.add(node.id);
      const abs = path.resolve(this.root, node.pluginPath);
      try {
        const mod = (await import(pathToFileURL(abs).href)) as { default?: unknown };
        const def = mod.default;
        if (!isPluginDefinition(def)) {
          throw new Error("plugin default export is not a valid definePlugin({...}) value");
        }
        this.byNode.set(node.id, def);
        await this.audit.append("plugin.loaded", {
          nodeId: node.id,
          data: { name: def.name, tools: def.tools?.length ?? 0, actions: def.actions?.length ?? 0 },
        });
      } catch (err) {
        await this.audit.append("plugin.load_failed", {
          nodeId: node.id,
          data: { path: node.pluginPath, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }
}
