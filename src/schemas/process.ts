import { z } from "zod";
import { Budget } from "./common.js";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * What kicks off a process. Agents are event-driven and otherwise idle — a
 * process does no work until its trigger fires.
 * - `manual`: started by the owner (chat / button / API).
 * - `schedule`: started on a cron expression.
 * - `event`: started by an external event (webhook / MCP) keyed by `event`.
 */
export const ProcessTrigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }).strict(),
  z.object({ type: z.literal("schedule"), cron: z.string().min(1) }).strict(),
  z.object({ type: z.literal("event"), event: z.string().min(1) }).strict(),
]);
export type ProcessTrigger = z.infer<typeof ProcessTrigger>;

/**
 * A first-class playbook. Processes are how work actually flows — they cut
 * across the org hierarchy. The `owner` role decomposes the playbook into task
 * contracts and dispatches them; `participants` are roles the process may
 * involve.
 *
 * The markdown body is the playbook itself (the steps, in prose), handed to the
 * owning agent as the goal to decompose.
 */
export const ProcessSpec = z
  .object({
    name: z.string().min(1),
    trigger: ProcessTrigger.default({ type: "manual" }),
    /** Role that owns execution (decomposes + dispatches). Must resolve to an agent. */
    owner: z.string().min(1),
    /** Roles this process may involve, for routing/validation. */
    participants: z.array(z.string().min(1)).default([]),
    /** Explicit, checkable completion criteria. Drives termination. */
    definitionOfDone: z.string().min(1),
    /**
     * Step names (or tool names) that always require human approval regardless
     * of per-tool policy — a process-level safety gate.
     */
    approvals: z.array(z.string().min(1)).default([]),
    /** Budget ceiling for one run of this process. */
    budget: Budget.optional(),
    /** The playbook steps, sourced from the markdown body. */
    playbook: z.string().min(1, "process.md must have a non-empty body (the playbook)"),
  })
  .strict();
export type ProcessSpec = z.infer<typeof ProcessSpec>;

/** Parse and validate raw `*.process.md` content. Throws ZodError on invalid input. */
export function parseProcessSpec(source: string): ProcessSpec {
  const { frontmatter, body } = parseFrontmatter(source);
  return ProcessSpec.parse({ ...frontmatter, playbook: body });
}
