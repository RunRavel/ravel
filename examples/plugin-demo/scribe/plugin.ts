import { z } from "zod";

/**
 * A team plugin: in-process code tools scoped to this team. The platform loads
 * this file's default export, exposes `tools` to the scribe (gated by its
 * tools.json), and registers `actions` on the executor for approved proposals.
 *
 * In a published setup you'd `import { definePlugin } from "@runravel/ravel"` for types;
 * in-repo we export the plain definition (the loader validates it structurally).
 */
export default {
  name: "notes",
  version: "1.0.0",

  tools: [
    {
      // Plain tool (policy `auto`): writes straight to team memory.
      name: "note_append",
      description: "Append a note to the team's shared notes list.",
      schema: { text: z.string() },
      handler: async (input: Record<string, unknown>, ctx: any) => {
        const raw = await ctx.memory.get(ctx.teamScope, "notes");
        const list = raw ? (JSON.parse(raw) as unknown[]) : [];
        list.push({ text: String(input["text"]), at: new Date().toISOString() });
        await ctx.memory.set(ctx.teamScope, "notes", JSON.stringify(list));
        return { ok: true, count: list.length };
      },
    },
    {
      // Gated tool (policy `ask`): the model-facing stub. The real write is the
      // identically-named action below, run by the executor on human approval.
      name: "publish_note",
      description: "Propose publishing a note externally (requires human approval).",
      schema: { text: z.string() },
      handler: async (input: Record<string, unknown>) => ({ proposed: `publish: ${String(input["text"])}` }),
    },
  ],

  actions: [
    {
      name: "publish_note",
      handler: async (input: unknown, ctx: any) => {
        if (!ctx.teamScope) return { ok: false, error: "no team scope on proposal" };
        const text = String((input as Record<string, unknown>)?.["text"] ?? "");
        const raw = await ctx.memory.get(ctx.teamScope, "published");
        const list = raw ? (JSON.parse(raw) as unknown[]) : [];
        list.push({ text, at: new Date().toISOString() });
        await ctx.memory.set(ctx.teamScope, "published", JSON.stringify(list));
        return { ok: true, result: `published "${text}"` };
      },
    },
  ],
};
