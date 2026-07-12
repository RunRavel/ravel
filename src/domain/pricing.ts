import type { Usage } from "./types.js";

/** Per-model pricing in USD per million tokens (input, output). */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Fallback pricing for unknown model ids — assume opus-tier so we never undercount spend. */
const FALLBACK = { input: 5, output: 25 };

/** Cache multipliers relative to the input rate (5-minute TTL). */
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

/** Cache-aware cost estimate in USD. */
export function estimateUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  const p = PRICING[model] ?? FALLBACK;
  return (
    (inputTokens * p.input +
      outputTokens * p.output +
      cacheReadTokens * p.input * CACHE_READ_MULT +
      cacheCreationTokens * p.input * CACHE_WRITE_MULT) /
    1_000_000
  );
}

/** Build a cache-aware Usage with cost filled in from the model's pricing. */
export function usageFor(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): Usage {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    usd: estimateUsd(model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens),
  };
}
