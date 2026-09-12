import { FIELD_REGISTRY } from "./registry.generated.ts";
import type { FieldMeta } from "./types.ts";

export { FIELD_REGISTRY };

// The default vector a trace follows and a synthetic reader emits. Canonical, 1-indexed component
// names (CLAUDE.md §Naming); three modules used to spell the triple out, under two names.
export const MAGNETIC_COMPONENTS = ["B_1", "B_2", "B_3"] as const;

// Resolve canonical field metadata, rejecting unknown names loudly — mirrors
// pypic's KeyError rule so typos don't get silently swallowed downstream.
export function fieldInfo(name: string): FieldMeta {
  const info = FIELD_REGISTRY[name];
  if (info === undefined) {
    throw new Error(`Unknown field name: ${name}`);
  }
  return info;
}
