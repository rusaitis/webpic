import { FIELD_REGISTRY } from "./registry.generated.ts";
import type { FieldMeta } from "./types.ts";

export { FIELD_REGISTRY };

// Resolve canonical field metadata, rejecting unknown names loudly — mirrors
// pypic's KeyError rule so typos don't get silently swallowed downstream.
export function fieldInfo(name: string): FieldMeta {
  const info = FIELD_REGISTRY[name];
  if (info === undefined) {
    throw new Error(`Unknown field name: ${name}`);
  }
  return info;
}
