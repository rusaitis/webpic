import { DATASET_CATALOG } from "@schema/datasets.ts";
import { fieldInfo } from "@schema/registry.ts";
import type { FieldName } from "@schema/types.ts";

// Pure readout formatters for the top menu bar (ui/topBar): dataset + field labels and the timestep
// index↔value math. Typed-in, string-out — no DOM, no store — so they're node-testable like
// ui/coordsInfo. fieldInfo() throws on an unknown canonical name (pypic's KeyError rule); the field
// helpers guard it and degrade to the raw name rather than crash the bar on a streamed/derived name.

const EMPTY = "—";

// Human label for a dataset id. The static catalog is the only dataset metadata the ui can reach (it
// can't touch the data layer); falls back to the id when the catalog omits it.
export function datasetLabel(id: string): string {
  return DATASET_CATALOG.find((d) => d.id === id)?.label ?? id;
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
// of snapping. Mirrors ui/panels/timePanel's strategy; shared here so the bar and panel agree.

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
