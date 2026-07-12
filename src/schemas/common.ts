import { z } from "zod";

/**
 * Logical model tiers. Authors pick a tier; the runtime resolves it to a
 * concrete model id (see `resolveModel`). Orchestrator/manager agents default
 * to opus for planning; workers default to sonnet. An author may also pass a
 * raw model id string to pin an exact model.
 */
export const ModelTier = z.enum(["opus", "sonnet", "haiku"]);
export type ModelTier = z.infer<typeof ModelTier>;

/** Concrete model ids the platform knows about (latest as of build). */
export const MODEL_IDS: Record<ModelTier, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

/** A model field accepts a known tier or an explicit model-id string. */
export const ModelRef = z.union([ModelTier, z.string().min(1)]);
export type ModelRef = z.infer<typeof ModelRef>;

export function resolveModel(ref: ModelRef | undefined, fallback: ModelTier): string {
  const value = ref ?? fallback;
  if (value in MODEL_IDS) return MODEL_IDS[value as ModelTier];
  return value; // explicit model id passed through verbatim
}

/**
 * A budget bounds the work an agent or task may do before it must terminate or
 * escalate. All fields are optional ceilings; the runtime enforces whichever
 * are present. This is the core guard against runaway autonomous loops.
 */
export const Budget = z
  .object({
    tokens: z.number().int().positive().optional(),
    usd: z.number().positive().optional(),
    seconds: z.number().int().positive().optional(),
    /** Max orchestration turns / dispatch cycles before forced termination. */
    turns: z.number().int().positive().optional(),
  })
  .strict();
export type Budget = z.infer<typeof Budget>;

/**
 * Per-tool permission policy. `auto` runs without asking, `ask` routes through
 * the human approval queue (HITL), `deny` blocks the tool entirely. The default
 * is intentionally `ask` — consequential actions should pause for a human until
 * an owner explicitly trusts them.
 */
export const PermissionPolicy = z.enum(["auto", "ask", "deny"]);
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;
