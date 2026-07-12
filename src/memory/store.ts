import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Where a piece of memory lives. The hierarchy keeps agents from re-learning
 * everything and contradicting each other:
 * - `agent`: private to one agent (alongside its working dir).
 * - `team`:  shared among the direct reports of one manager.
 * - `org`:   company-wide facts/policies/glossary — read widely, written rarely.
 */
export type MemoryScope =
  | { kind: "agent"; nodeId: string }
  | { kind: "team"; managerNodeId: string }
  | { kind: "org" };

function sanitize(id: string): string {
  return id === "" ? "_root" : id.replace(/\//g, "__");
}

/**
 * File-backed memory keyed by scope + name. Values are plain text (markdown).
 * `org` writes are gated: callers must pass `{ allowOrgWrite: true }` so a
 * worker can't casually rewrite company-wide facts.
 */
export class MemoryStore {
  constructor(private readonly root: string) {}

  private dir(scope: MemoryScope): string {
    switch (scope.kind) {
      case "agent":
        return path.join(this.root, "agent", sanitize(scope.nodeId));
      case "team":
        return path.join(this.root, "team", sanitize(scope.managerNodeId));
      case "org":
        return path.join(this.root, "org");
    }
  }

  private file(scope: MemoryScope, key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.dir(scope), `${safeKey}.md`);
  }

  async get(scope: MemoryScope, key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.file(scope, key), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async set(
    scope: MemoryScope,
    key: string,
    value: string,
    opts: { allowOrgWrite?: boolean } = {},
  ): Promise<void> {
    if (scope.kind === "org" && !opts.allowOrgWrite) {
      throw new Error("org memory is write-gated; pass { allowOrgWrite: true }");
    }
    const file = this.file(scope, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value, "utf8");
  }

  async list(scope: MemoryScope): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir(scope));
      return entries.filter((e) => e.endsWith(".md")).map((e) => e.slice(0, -3)).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}
