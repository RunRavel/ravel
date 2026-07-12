import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Parse `.env` content into a map: `KEY=VALUE` per line, `#` comments and blank
 * lines skipped, surrounding single/double quotes stripped. Shared by the CLI's
 * global loader and the per-node `SecretStore`.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** A valid env var name (used to gate UI writes). */
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Per-node credential resolver. Secrets live in a `.env` file co-located with each
 * agent folder; an agent's effective environment is the merge of every `.env` from
 * its own folder up to the org root, **most-specific (deepest) wins**. This scopes
 * credentials per agent: an agent only ever sees its own dir→root chain, so a
 * sibling agent's `.env` (e.g. a write key) is unreachable.
 *
 * Returns only file-sourced vars; callers fall back to `process.env` for anything
 * not set per-node (so global keys like ANTHROPIC_API_KEY keep working).
 */
export class SecretStore {
  private readonly root: string;

  constructor(orgRoot: string) {
    this.root = path.resolve(orgRoot);
  }

  /** The chain of `.env` paths from the org root down to (and including) nodeDir. */
  private chain(nodeDir: string): string[] {
    const abs = path.resolve(nodeDir);
    // Stay within the org root; ignore anything outside it.
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) return [];
    const dirs: string[] = [];
    let cur = abs;
    while (true) {
      dirs.unshift(cur); // root-first so deeper dirs overwrite shallower ones
      if (cur === this.root) break;
      cur = path.dirname(cur);
    }
    return dirs.map((d) => path.join(d, ".env"));
  }

  /** Merge `.env` files from org root → nodeDir (deepest wins). File-sourced only. */
  async resolve(nodeDir: string): Promise<Record<string, string>> {
    const merged: Record<string, string> = {};
    for (const file of this.chain(nodeDir)) {
      let content: string;
      try {
        content = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      Object.assign(merged, parseDotEnv(content));
    }
    return merged;
  }

  /** Key NAMES set directly on this node's own `.env` (for the masked UI). */
  async listKeys(nodeDir: string): Promise<string[]> {
    const file = this.envPath(nodeDir);
    if (!file) return [];
    try {
      return Object.keys(parseDotEnv(await fs.readFile(file, "utf8")));
    } catch {
      return [];
    }
  }

  /** Set (or replace) a key in this node's own `.env`. */
  async setKey(nodeDir: string, key: string, value: string): Promise<void> {
    if (!ENV_KEY_RE.test(key)) throw new Error(`invalid env key "${key}"`);
    const file = this.requireEnvPath(nodeDir);
    const current = await this.readOwn(file);
    current[key] = value;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serialize(current), "utf8");
  }

  /** Remove a key from this node's own `.env`. */
  async deleteKey(nodeDir: string, key: string): Promise<void> {
    const file = this.requireEnvPath(nodeDir);
    const current = await this.readOwn(file);
    delete current[key];
    await fs.writeFile(file, serialize(current), "utf8");
  }

  private async readOwn(file: string): Promise<Record<string, string>> {
    try {
      return parseDotEnv(await fs.readFile(file, "utf8"));
    } catch {
      return {};
    }
  }

  /** The node's own `.env` path, or null if nodeDir escapes the org root. */
  private envPath(nodeDir: string): string | null {
    const abs = path.resolve(nodeDir);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) return null;
    return path.join(abs, ".env");
  }

  private requireEnvPath(nodeDir: string): string {
    const file = this.envPath(nodeDir);
    if (!file) throw new Error("node directory escapes the org root");
    return file;
  }
}

function serialize(env: Record<string, string>): string {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return lines.length ? lines.join("\n") + "\n" : "";
}
