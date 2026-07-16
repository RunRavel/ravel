import { z } from "zod";

/**
 * `ravel.json` — the optional team manifest at the org root. Teams may omit it
 * entirely (the examples do); when present it names the team and, importantly,
 * pins the runtime it was authored against so `validate`/`serve` can warn on a
 * version mismatch.
 */
export const Manifest = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    /**
     * Semver range of the runtime this team targets (e.g. "^0.2"). Warn-only:
     * a mismatch never blocks, it just flags drift between the team's expected
     * config format and the installed `@runravel/ravel`.
     */
    runtimeVersion: z.string().min(1).optional(),
  })
  .strict();
export type Manifest = z.infer<typeof Manifest>;

/** Parse and validate raw `ravel.json` content. Throws ZodError on invalid input. */
export function parseManifest(source: string): Manifest {
  const data: unknown = JSON.parse(source);
  return Manifest.parse(data);
}

/**
 * Minimal, warn-only semver range check — enough for the caret/tilde/exact
 * forms teams actually pin (`^0.2`, `~0.2.1`, `0.2.0`). Not a full semver
 * implementation: prerelease tags and complex ranges fall back to `true`
 * (don't warn) rather than risk a false mismatch on a warning-only signal.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return true;
  const r = range.trim();
  const op = r.startsWith("^") ? "^" : r.startsWith("~") ? "~" : "=";
  const bound = parseVersion(r.replace(/^[\^~]/, ""));
  if (!bound) return true; // unparseable range → don't warn

  if (op === "=") {
    // Exact: match the components the range specifies.
    return v.major === bound.major && v.minor === bound.minor && v.patch === bound.patch;
  }
  if (v.major !== bound.major) return false;
  if (op === "^") {
    // ^0.y.z is minor-locked (0.y.*); ^x.y.z (x>=1) allows >= within the major.
    if (bound.major === 0) return v.minor === bound.minor && v.patch >= bound.patch;
    return v.minor > bound.minor || (v.minor === bound.minor && v.patch >= bound.patch);
  }
  // ~: allow patch-level changes within major.minor.
  return v.minor === bound.minor && v.patch >= bound.patch;
}

function parseVersion(s: string): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(s.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0) };
}
