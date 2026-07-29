import type { AgentEngine, EngineRequest, EngineResult, EngineToolUse } from "./engine.js";
import { emptyUsage, addUsage, type Usage, type PermissionDecision } from "../domain/types.js";

/** Context a scripted program uses to simulate an agent's behavior. */
export interface FakeContext {
  req: EngineRequest;
  /**
   * Attempt a tool use; routes through the runtime's decide() gate. An optional
   * `output` simulates the tool's result so it reaches the captured toolUses
   * (and the `tool.finished` audit event) — mirroring what SdkEngine observes.
   */
  useTool: (name: string, input: unknown, rationale?: string, output?: unknown) => Promise<PermissionDecision>;
  /** Report simulated token usage (also forwarded to the runtime's budget meter). */
  emitUsage: (u: Usage) => void;
  /** Resolves true once the run has been aborted (kill / budget / timeout). */
  aborted: () => boolean;
}

export type FakeProgram = (ctx: FakeContext) => Promise<string> | string;

/**
 * A deterministic, offline AgentEngine for tests. Each `run` consumes the next
 * queued program (or the default). Programs may attempt tool uses (exercising
 * the approval gate) and emit usage (exercising budget enforcement).
 */
export class FakeEngine implements AgentEngine {
  private queue: FakeProgram[];

  constructor(
    private readonly defaultProgram: FakeProgram = () => "ok",
    programs: FakeProgram[] = [],
  ) {
    this.queue = [...programs];
  }

  /** Queue a program for the next run. Returns the engine for chaining. */
  enqueue(program: FakeProgram): this {
    this.queue.push(program);
    return this;
  }

  async run(req: EngineRequest): Promise<EngineResult> {
    const program = this.queue.shift() ?? this.defaultProgram;
    let usage = emptyUsage();
    const toolUses: EngineToolUse[] = [];

    const ctx: FakeContext = {
      req,
      useTool: async (name, input, rationale, output) => {
        toolUses.push({ name, input, ...(output !== undefined ? { output } : {}) });
        return req.decide({ name, input, ...(rationale !== undefined ? { rationale } : {}) });
      },
      emitUsage: (u) => {
        usage = addUsage(usage, u);
        req.onUsage?.(u);
      },
      aborted: () => req.signal.aborted,
    };

    try {
      const text = await program(ctx);
      if (req.signal.aborted) {
        return { text, usage, stopReason: "aborted", toolUses };
      }
      return { text, usage, stopReason: "done", toolUses };
    } catch (err) {
      if (req.signal.aborted) {
        return { text: "", usage, stopReason: "aborted", toolUses };
      }
      return {
        text: "",
        usage,
        stopReason: "error",
        toolUses,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
