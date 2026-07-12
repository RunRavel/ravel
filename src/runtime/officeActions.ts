import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Office actions are consequential business actions (send email, send a
 * proposal, deliver to a client). They are defined once here and used by BOTH:
 * - the in-process MCP tool ([officeTools.ts]) — so the model can *request* them
 *   (which routes through the approval gate), and
 * - the async ActionExecutor — which *performs* the approved action.
 *
 * The effect is deliberately simple (append a durable record to the run's
 * `shared/_office_log.md`); wiring a real provider (SMTP, CRM, delivery portal)
 * means replacing the body of `runOfficeAction` while the approval semantics
 * stay identical.
 */
export const OFFICE_ACTIONS = {
  send_email: { verb: "email", description: "Send an outbound email. Consequential and externally visible." },
  send_proposal: { verb: "proposal", description: "Send a proposal/quote to a prospect. Consequential and externally visible." },
  deliver_to_client: { verb: "delivery", description: "Deliver final files to a client. Irreversible client-facing action." },
} as const;

export type OfficeActionName = keyof typeof OFFICE_ACTIONS;
export const OFFICE_TOOL_NAMES = Object.keys(OFFICE_ACTIONS) as OfficeActionName[];

export function isOfficeAction(name: string): name is OfficeActionName {
  return name in OFFICE_ACTIONS;
}

export interface OfficeActionContext {
  /** Workspace root; the action writes under `cwd/shared`. */
  cwd: string;
  nodeId?: string;
  runId?: string;
}

export interface OfficeActionResult {
  ok: boolean;
  result?: string;
  error?: string;
}

/** Perform an office action deterministically (no model involved). */
export async function runOfficeAction(
  name: string,
  input: unknown,
  ctx: OfficeActionContext,
): Promise<OfficeActionResult> {
  if (!isOfficeAction(name)) return { ok: false, error: `unknown office action "${name}"` };
  const def = OFFICE_ACTIONS[name];
  try {
    const dir = path.join(ctx.cwd, "shared");
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, "_office_log.md"), `- ${def.verb}: ${JSON.stringify(input)}\n`, "utf8");
    return { ok: true, result: `${def.verb} recorded in shared/_office_log.md` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
