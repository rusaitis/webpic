import { SPECIES_SUFFIX_RE } from "./aliases.generated.ts";
import { FIELD_REGISTRY } from "./registry.generated.ts";
import type { FieldMeta } from "./types.ts";

export { FIELD_REGISTRY };

// The default vector a trace follows and a synthetic reader emits. Canonical, 1-indexed component
// names (CLAUDE.md §Naming); three modules used to spell the triple out, under two names.
export const MAGNETIC_COMPONENTS = ["B_1", "B_2", "B_3"] as const;

// pypic's registry lists base canonical forms (B_1, V_1, P_11, n_s0) but synthesizes per-species
// *component* names (V_s0_1, P_s0_11) via the species-suffix regex. Strip the `_sN` infix while
// keeping the trailing component/magnitude suffix: V_s0_1 → V_1, P_s0_11 → P_11, |V_s0| → |V|.
// n_s0 is itself a registry key (direct hit).
function deSpecies(name: string): string | null {
  const match = SPECIES_SUFFIX_RE.exec(name);
  if (match === null) return null;
  const suffix = match.groups?.suffix ?? "";
  return name.slice(0, match.index) + suffix;
}

// Registry meta for a canonical name, resolving per-species components to their base.
export function resolveFieldMeta(name: string): FieldMeta | undefined {
  const direct = FIELD_REGISTRY[name];
  if (direct !== undefined) return direct;
  const base = deSpecies(name);
  if (base !== null && base !== name) return FIELD_REGISTRY[base];
  return undefined;
}

export function isCanonicalFieldName(name: string): boolean {
  return resolveFieldMeta(name) !== undefined;
}

// The same resolution, rejecting unknown names loudly — mirrors pypic's KeyError rule so typos
// don't get silently swallowed downstream. Callers that display whatever a dataset carries want
// resolveFieldMeta instead: a reader admits per-species components, so throwing on them here is
// how a field panel dies on a multi-species run.
export function fieldInfo(name: string): FieldMeta {
  const info = resolveFieldMeta(name);
  if (info === undefined) {
    throw new Error(`fieldInfo: unknown canonical field name, got "${name}"`);
  }
  return info;
}
