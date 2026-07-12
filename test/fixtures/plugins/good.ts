import { z } from "zod";

export default {
  name: "fixture-good",
  version: "1.0.0",
  tools: [
    {
      name: "echo",
      description: "Echo a message back.",
      schema: { msg: z.string() },
      handler: async (input: Record<string, unknown>) => ({ echoed: String(input["msg"]) }),
    },
  ],
  actions: [{ name: "do_thing", handler: async () => ({ ok: true, result: "did it" }) }],
};
