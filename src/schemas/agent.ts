import { z } from "zod";
import { Budget, ModelRef } from "./common.js";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * The authored shape of an `agent.md` file. Frontmatter carries machine fields;
 * the markdown body becomes the agent's system prompt.
 *
 * Hierarchy note: an agent's *position* in the folder tree (its parent and
 * children) defines escalation and permission scope, NOT execution flow. Who
 * does what work is decided by processes (see ProcessSpec) and by the
 * orchestrator dispatching task contracts.
 */
export const AgentSpec = z
  .object({
    /** Human-readable name, e.g. "Sales Manager". */
    name: z.string().min(1),
    /** Role title used in prompts and routing, e.g. "manager", "researcher". */
    role: z.string().min(1).optional(),
    /** Model tier or explicit id. Defaults are applied by the runtime per altitude. */
    model: ModelRef.optional(),
    /**
     * How much latitude this agent has when acting.
     * - `orchestrated`: only acts on dispatched task contracts; no self-directed loops.
     * - `bounded`: may act autonomously within its budget and approval policy.
     */
    autonomy: z.enum(["orchestrated", "bounded"]).default("orchestrated"),
    /** Default budget ceiling applied to this agent's tasks unless overridden. */
    budget: Budget.optional(),
    /** Free-text escalation guidance surfaced to the agent. */
    escalation: z.string().optional(),
    /** The system prompt. Sourced from the markdown body, never frontmatter. */
    systemPrompt: z.string().min(1, "agent.md must have a non-empty body (the system prompt)"),
  })
  .strict();

export type AgentSpec = z.infer<typeof AgentSpec>;

/**
 * Parse and validate raw `agent.md` content into an AgentSpec.
 * Throws a ZodError on invalid input — the caller (registry compiler) turns
 * that into a diagnostic and keeps the last-good snapshot.
 */
export function parseAgentSpec(source: string): AgentSpec {
  const { frontmatter, body } = parseFrontmatter(source);
  return AgentSpec.parse({ ...frontmatter, systemPrompt: body });
}
