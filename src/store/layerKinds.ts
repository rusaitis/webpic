import type { GridInfo } from "@containers/field_dataset.ts";
import type { FieldLayerKind, LayerKind, TracingLayerKind } from "@schema/layers.ts";
import type { FieldName } from "@schema/types.ts";
import { defaultSeedRake } from "./interaction/seedPick.ts";
import type { Layer, LayerSpec } from "./layers.ts";

// One registration per layer kind on the store side: how it is named, what it draws, and what a
// fresh instance looks like. Typed as a complete record, so adding a kind to @schema/layers is a
// compile error here (and in every other `Record<LayerKind, …>` table) until it is described.

export interface LayerKindDescriptor {
  // Rail / settings title.
  readonly label: string;
  // Layers-panel row label — shorter where the row is tight.
  readonly shortLabel: string;
  // Draws the active scalar field (rides `upsertLayer`); field lines draw traced polylines instead.
  readonly drawsField: boolean;
  // Owns traced field lines — adding one triggers a retrace.
  readonly tracesLines: boolean;
  // Position among the tool rail's add-buttons, ascending. On the descriptor rather than a separate
  // list, so a new kind cannot compile without claiming a place in the rail.
  readonly railOrder: number;
  // A fresh instance on `field`: visible, opaque, no binding yet. `grid` seeds a default rake for
  // field lines; null (no dataset) leaves the seed set empty.
  makeDefaultSpec(field: FieldName, grid: GridInfo | null): LayerSpec;
}

export const LAYER_KINDS: Readonly<Record<LayerKind, LayerKindDescriptor>> = {
  volume: {
    railOrder: 0,
    label: "Volume",
    shortLabel: "Volume",
    drawsField: true,
    tracesLines: false,
    // steps/density defer to the render-side defaults.
    makeDefaultSpec: (field) => ({
      kind: "volume",
      field,
      colormapBindingId: null,
      visible: true,
      opacity: 1,
      steps: null,
      density: null,
      shaded: false,
    }),
  },
  slice: {
    railOrder: 1,
    label: "Slice",
    shortLabel: "Slice",
    drawsField: true,
    tracesLines: false,
    // The legacy app slice: axis z, mid-plane.
    makeDefaultSpec: (field) => ({
      kind: "slice",
      field,
      colormapBindingId: null,
      visible: true,
      opacity: 1,
      axis: "z",
      position: 0.5,
    }),
  },
  fieldlines: {
    railOrder: 2,
    label: "Field lines",
    shortLabel: "Lines",
    drawsField: false,
    tracesLines: true,
    makeDefaultSpec: (field, grid) => ({
      kind: "fieldlines",
      field,
      colormapBindingId: null,
      visible: true,
      opacity: 1,
      seeds: grid === null ? [] : defaultSeedRake(grid),
    }),
  },
};

export const LAYER_KIND_ORDER: readonly LayerKind[] = Object.keys(LAYER_KINDS)
  .map((kind) => kind as LayerKind) // Object.keys widens to string; the table's keys are the union
  .sort((a, b) => LAYER_KINDS[a].railOrder - LAYER_KINDS[b].railOrder);

export type FieldLayer = Extract<Layer, { readonly kind: FieldLayerKind }>;

// Narrow to the layers that draw the active scalar field.
export function isFieldLayer(layer: Layer): layer is FieldLayer {
  return LAYER_KINDS[layer.kind].drawsField;
}

export type TracingLayer = Extract<Layer, { readonly kind: TracingLayerKind }>;

// Narrow to the layers that own traced polylines. Routing on the descriptor rather than the literal
// is what makes `tracesLines` load-bearing: a new kind that declares it is traced everywhere at once.
export function isTracingLayer(layer: Layer): layer is TracingLayer {
  return LAYER_KINDS[layer.kind].tracesLines;
}
