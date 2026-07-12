import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Builds a throwaway org folder tree on disk from a map of relative path →
 * file contents, and returns the root. Directories are created as needed.
 * Caller is responsible for cleanup via `cleanup`.
 */
export async function makeTempOrg(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-org-"));
  await writeFiles(root, files);
  return root;
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }
}

export async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

/** Convenience: a minimal valid agent.md body for a node. */
export function agentMd(name: string, extra: Record<string, string> = {}, body = "Do the work."): string {
  const fm = Object.entries({ name, ...extra })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${fm}\n---\n${body}\n`;
}
