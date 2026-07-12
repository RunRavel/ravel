import { randomUUID } from "node:crypto";

/** Short, prefixed, sortable-ish id. Prefix communicates the kind at a glance. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

/** Injectable clock so time-dependent logic stays testable. */
export interface Clock {
  now(): number;
  iso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};
