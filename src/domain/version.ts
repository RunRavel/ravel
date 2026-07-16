import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * The installed `@runravel/ravel` version, read from the package's own
 * package.json (two levels up from src/domain/). Cached after first read.
 * Used to warn when a team's `ravel.json` pins a `runtimeVersion` the installed
 * runtime doesn't satisfy.
 */
let cached: string | null = null;

export function runtimeVersion(): string {
  if (cached !== null) return cached;
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    cached = pkg.version ?? "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
