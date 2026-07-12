#!/usr/bin/env node
// Ravel CLI entry — registers the tsx loader, then runs the TS CLI (Ravel ships
// TypeScript source and executes it via tsx; no build step for v0.1).
import { register } from "tsx/esm/api";
register();
await import(new URL("../src/cli/main.ts", import.meta.url).href);
