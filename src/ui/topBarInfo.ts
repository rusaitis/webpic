import { DATASET_CATALOG } from "@schema/datasets.ts";
import { fieldInfo } from "@schema/registry.ts";
import type { FieldName } from "@schema/types.ts";
import { parse as parseToml } from "smol-toml";

// Pure readout formatters for the top menu bar (ui/topBar): dataset + field labels and the timestep
// index↔value math. Typed-in, string-out — no DOM, no store — so they're node-testable like
// ui/coordsInfo. fieldInfo() throws on an unknown canonical name (pypic's KeyError rule); the field
// helpers guard it and degrade to the raw name rather than crash the bar on a streamed/derived name.

const EMPTY = "—";

// Human label for a dataset: what the loaded data calls itself, over the static catalog, over the
// raw id. The run-name chain is DESIGN §Run metadata's consumption rule — prefer the typed
// `attrs.run`, fall back to re-parsing `attrs.simulation_toml` — with this label as its first
// consumer (the reserved keys ride the dataset's metadata bag, re-stuffed by the reader).
export function datasetLabel(id: string, metadata?: Readonly<Record<string, unknown>>): string {
  return runName(metadata) ?? DATASET_CATALOG.find((d) => d.id === id)?.label ?? id;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function runName(metadata: Readonly<Record<string, unknown>> | undefined): string | null {
  if (metadata === undefined) return null;
  const run = metadata.run;
  if (isRecord(run)) {
    const name = nonEmptyString(run.name);
    if (name !== null) return name;
  }
  const toml = metadata.simulation_toml;
  if (typeof toml === "string") {
    try {
      const table = parseToml(toml).run;
      if (isRecord(table)) return nonEmptyString(table.name);
    } catch {
      // malformed TOML names nothing — fall through to the catalog
    }
  }
  return null;
}

// The short label shown ON the content button — the active field's long name, or the raw canonical
// name when the registry doesn't know it (a derived/streamed quantity without metadata).
export function fieldButtonLabel(name: FieldName): string {
  try {
    return fieldInfo(name).longName;
  } catch {
    return name;
  }
}

// Field-select option order: available fields as-is, but with the active field guaranteed present
// (prepended when not yet in the computed set) so the control always has a row matching its value.
// Single-sourced here so the top bar's picker and the docked field panel can't diverge.
export function orderedFieldNames(
  available: readonly FieldName[],
  active: FieldName,
): readonly FieldName[] {
  return available.includes(active) ? available : [active, ...available];
}

export interface FieldMetaRow {
  readonly label: string;
  readonly value: string;
}

// One field's metadata rows for a content-popover entry. Always returns the Name row; the rest only
// when the registry knows the field. Empty unit/latex read as an em dash, never "".
export function fieldMetaRows(name: FieldName): readonly FieldMetaRow[] {
  try {
    const meta = fieldInfo(name);
    return [
      { label: "Name", value: name },
      { label: "Quantity", value: meta.longName },
      { label: "Unit", value: meta.siUnit || EMPTY },
      { label: "LaTeX", value: meta.latex || EMPTY },
    ];
  } catch {
    return [{ label: "Name", value: name }];
  }
}

// Timestep slider math: the control walks INDICES into availableSteps (a contiguous [0, len-1]
// domain), never the raw step values — robust to sparse/non-contiguous steps ([0,5,10,25]) and free
// of snapping. These index↔step helpers live here as the bar's single source of timestep math.

// Slider value (index) for a step; clamps to 0 when the step isn't in the domain.
export function stepIndex(step: number, steps: readonly number[]): number {
  const i = steps.indexOf(step);
  return i < 0 ? 0 : i;
}

// The step value at a slider index, or undefined when out of range (empty domain / rounding slop).
export function stepAt(index: number, steps: readonly number[]): number | undefined {
  return steps[Math.round(index)];
}

// Readout for the slider's step label: "step N", or an em dash on an empty domain.
export function stepReadout(index: number, steps: readonly number[]): string {
  const step = stepAt(index, steps);
  return step === undefined ? EMPTY : `step ${step}`;
}
