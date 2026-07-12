import { parse as parseYaml } from "yaml";

/**
 * Splits a markdown document into its YAML frontmatter and body.
 *
 * Supports the conventional `---\n<yaml>\n---\n<body>` form. If no frontmatter
 * fence is present, the whole document is treated as the body with empty
 * frontmatter — this keeps authoring forgiving (an `agent.md` that is pure prose
 * is still valid; only the schema decides what is required).
 */
export interface ParsedDocument {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(source: string): ParsedDocument {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: source.trim() };
  }

  const [, rawYaml = "", body = ""] = match;
  let frontmatter: Record<string, unknown> = {};
  if (rawYaml.trim().length > 0) {
    const parsed: unknown = parseYaml(rawYaml);
    if (parsed !== null && typeof parsed === "object") {
      frontmatter = parsed as Record<string, unknown>;
    } else if (parsed !== null && parsed !== undefined) {
      throw new Error("Frontmatter must be a YAML mapping (key: value pairs)");
    }
  }

  return { frontmatter, body: body.trim() };
}
