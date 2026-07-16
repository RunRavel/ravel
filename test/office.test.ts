import { describe, it, expect } from "vitest";
import { policyForTool } from "../src/trust/approval.js";
import { buildOfficeServer, OFFICE_TOOL_NAMES } from "../src/runtime/officeTools.js";
import type { ToolsConfig } from "../src/schemas/tools.js";

const cfg: ToolsConfig = {
  tools: [{ name: "deliver_to_client", policy: "ask" }],
  mcpServers: {},
  env: [],
  defaultPolicy: "auto",
};

describe("policyForTool MCP name normalization", () => {
  it("maps a namespaced MCP tool to its bare grant", () => {
    expect(policyForTool(cfg, "mcp__office__deliver_to_client")).toBe("ask");
    expect(policyForTool(cfg, "deliver_to_client")).toBe("ask");
  });

  it("falls back to defaultPolicy for ungranted tools", () => {
    expect(policyForTool(cfg, "mcp__office__send_email")).toBe("auto"); // defaultPolicy
  });
});

describe("policyForTool safe read-only set", () => {
  // An agent with no grants and the strictest default (ask).
  const strict: ToolsConfig = { tools: [], mcpServers: {}, env: [],
 defaultPolicy: "ask" };

  it("auto-allows injected read-only built-ins even under defaultPolicy ask", () => {
    expect(policyForTool(strict, "Read")).toBe("auto");
    expect(policyForTool(strict, "Glob")).toBe("auto");
    expect(policyForTool(strict, "Grep")).toBe("auto");
  });

  it("still gates consequential/unknown tools under defaultPolicy ask", () => {
    expect(policyForTool(strict, "Write")).toBe("ask");
    expect(policyForTool(strict, "Bash")).toBe("ask");
    expect(policyForTool(strict, "mcp__office__deliver_to_client")).toBe("ask");
  });

  it("lets an explicit grant override the safe default", () => {
    const gated: ToolsConfig = { tools: [{ name: "Glob", policy: "deny" }], mcpServers: {}, env: [],
 defaultPolicy: "ask" };
    expect(policyForTool(gated, "Glob")).toBe("deny");
  });
});

describe("buildOfficeServer", () => {
  it("exposes the known office tools", () => {
    expect(OFFICE_TOOL_NAMES).toEqual(["send_email", "send_proposal", "deliver_to_client"]);
  });

  it("returns a server only when an office tool is granted", () => {
    expect(buildOfficeServer(["deliver_to_client"], "/tmp")).not.toBeNull();
    expect(buildOfficeServer([], "/tmp")).toBeNull();
    expect(buildOfficeServer(["Read", "Write"], "/tmp")).toBeNull(); // non-office tools
  });
});
