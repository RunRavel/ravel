/**
 * Ravel — public API surface.
 *
 * The stable entry point for consumers: **team plugins** import the memory,
 * plugin, and helper types from here instead of deep paths; a **hosting platform**
 * imports `App` and the engine to embed the runtime. Deep `src/...` imports are not
 * part of the contract and may change between versions.
 */

// --- platform / runtime ------------------------------------------------------
export { App } from "./platform/app.js";
export type { AppOptions } from "./platform/app.js";
export { SdkEngine, assembleMcpServers } from "./runtime/sdkEngine.js";
export { FakeEngine } from "./runtime/fakeEngine.js";
export type { AgentEngine, EngineRequest, EngineResult, ToolContext, EngineToolUse } from "./runtime/engine.js";

// --- memory ------------------------------------------------------------------
export { MemoryStore } from "./memory/store.js";
export type { MemoryScope } from "./memory/store.js";
export { withLock, lockKey, readJson, json } from "./memory/kv.js";
export { queueAppend, queueClear, resolveScope, buildGenericMemoryServer, GENERIC_MEMORY_TOOL_NAMES } from "./memory/genericTools.js";

// --- plugins (what a team's plugin.ts builds against) ------------------------
export { definePlugin, isPluginDefinition } from "./plugins/types.js";
export type {
  PluginDefinition,
  PluginTool,
  PluginAction,
  PluginToolCtx,
  PluginActionCtx,
  PluginActionResult,
} from "./plugins/types.js";

// --- trust (executor action contract for gated plugin actions) --------------
export type { ActionHandler, ActionContext, ActionResult } from "./trust/executor.js";

// --- config validation (declarative catalog + advisory lint) ----------------
export { TOOL_CATALOG, BUILTIN_TOOLS, isCatalogTool, isMemoryWriteTool } from "./schemas/catalog.js";
export type { CatalogEntry, ToolKind, ToolAccess } from "./schemas/catalog.js";
export { lintRegistry } from "./control-plane/lint.js";
export type { LintContext } from "./control-plane/lint.js";
export type { Diagnostic } from "./control-plane/registry.js";
export { parseManifest, satisfiesRange } from "./schemas/manifest.js";
export type { Manifest } from "./schemas/manifest.js";
export { runtimeVersion } from "./domain/version.js";
