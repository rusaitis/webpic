// The tag pypic writes on a JSON-coerced value, and the guard both sides narrow with. This is the
// wire contract between fromJsonNative (readers/decode.ts) and toJsonNative (writers/zarr.ts) —
// declared once so the two halves of the round-trip cannot drift apart on the string.

export const PYPIC_CLASS = "__pypic_class__";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
