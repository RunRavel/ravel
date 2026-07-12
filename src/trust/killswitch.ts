/**
 * Instant stop control. The owner can halt one agent, a whole team (subtree),
 * or the entire org. Each in-flight run registers an AbortController; killing a
 * scope aborts every matching run and blocks new runs in that scope until it is
 * cleared.
 *
 * Scope matching is by node-id prefix: scope `"sales"` kills `sales` and
 * `sales/researcher`; scope `"*"` kills everything.
 */
export class KillSwitch {
  private readonly active = new Map<string, Set<AbortController>>();
  private readonly killedScopes = new Set<string>();

  private matches(scope: string, nodeId: string): boolean {
    if (scope === "*") return true;
    return nodeId === scope || nodeId.startsWith(`${scope}/`);
  }

  /** Is this node currently under an active kill scope? */
  isKilled(nodeId: string): boolean {
    for (const scope of this.killedScopes) {
      if (this.matches(scope, nodeId)) return true;
    }
    return false;
  }

  /**
   * Register an in-flight run for a node. Returns an AbortController whose
   * signal fires if the node's scope is (or becomes) killed. Caller must call
   * `release` when the run ends.
   */
  register(nodeId: string): AbortController {
    const controller = new AbortController();
    if (this.isKilled(nodeId)) {
      controller.abort(new Error(`node ${nodeId} is under an active kill`));
      return controller;
    }
    let set = this.active.get(nodeId);
    if (!set) {
      set = new Set();
      this.active.set(nodeId, set);
    }
    set.add(controller);
    return controller;
  }

  release(nodeId: string, controller: AbortController): void {
    this.active.get(nodeId)?.delete(controller);
  }

  /** Halt a scope: abort all matching in-flight runs and block new ones. */
  kill(scope: string): number {
    this.killedScopes.add(scope);
    let aborted = 0;
    for (const [nodeId, set] of this.active) {
      if (!this.matches(scope, nodeId)) continue;
      for (const controller of set) {
        controller.abort(new Error(`killed: scope ${scope}`));
        aborted += 1;
      }
    }
    return aborted;
  }

  /** Clear a kill scope so the node(s) can run again. */
  clear(scope: string): void {
    this.killedScopes.delete(scope);
  }

  clearAll(): void {
    this.killedScopes.clear();
  }
}
