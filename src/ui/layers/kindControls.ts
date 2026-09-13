import type { LayerKind } from "@schema/layers.ts";
import { clamp } from "@schema/math.ts";
import type { Layer, SimulationStore, SliceAxis, TraceNotice } from "@store";
import type { Folder, NoteHandle } from "../controls/types.ts";

// What each layer kind adds to the settings form, and how it reflects an edit without a rebuild. A
// complete Record<LayerKind, …>, so a new kind is a compile error here until it says what it
// configures. Each builder returns its own reflect closure, so a kind's control handles never leave
// the entry that made them and cannot be driven by another kind's layer.

const SLICE_AXES: ReadonlyArray<{ value: SliceAxis; label: string }> = [
  { value: "x", label: "x" },
  { value: "y", label: "y" },
  { value: "z", label: "z" },
];

// Seed-rake bounds for the count slider (defaultSeedRake floors at 2). 32 keeps the CPU re-trace snappy.
const MIN_SEEDS = 2;
const MAX_SEEDS = 32;

// The slider's range is narrower than a placed rake may be, so the displayed count is the clamped
// one — the layer keeps its real seeds either way.
const seedCountFor = (layer: { readonly seeds: ReadonlyArray<unknown> }): number =>
  clamp(layer.seeds.length, MIN_SEEDS, MAX_SEEDS);

const PLACE_HINT = 'toggle "Place seeds", then click the volume';

// The field-lines status line: seeds asked for, lines drawn, the vector they followed, and why any
// seed was dropped. `notice` is undefined until the layer's first retrace lands.
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

function seedSummary(n: number, notice: TraceNotice | undefined): string {
  const seeds = plural(n, "seed");
  if (notice === undefined) return `${seeds} · ${PLACE_HINT}`;
  if (notice.error !== null) return `${seeds} · ${notice.error}`;
  const drawn = notice.traced === 0 ? "no lines" : plural(notice.traced, "line");
  const parts = [seeds, drawn];
  if (notice.fieldName !== null) parts.push(notice.fieldName);
  if (notice.nullSeeds > 0) parts.push(`${plural(notice.nullSeeds, "seed")} at a field null`);
  if (notice.outsideSeeds > 0)
    parts.push(`${plural(notice.outsideSeeds, "seed")} outside the domain`);
  if (notice.failedSeeds > 0) parts.push(`${plural(notice.failedSeeds, "seed")} would not trace`);
  if (notice.traced === n) parts.push(PLACE_HINT);
  return parts.join(" · ");
}

// Seeds skipped or nothing drawn — amber, so an empty layer never reads as an empty scene.
function applySeedNote(note: NoteHandle, seedCount: number, notice: TraceNotice | undefined): void {
  note.element.textContent = seedSummary(seedCount, notice);
  const isIncomplete =
    notice !== undefined && (notice.error !== null || notice.traced < notice.requested);
  if (isIncomplete) note.element.dataset.kind = "warn";
  else note.element.removeAttribute("data-kind");
}

type LayerOfKind<K extends LayerKind> = Extract<Layer, { readonly kind: K }>;

type KindControls<K extends LayerKind> = (
  folder: Folder,
  layer: LayerOfKind<K>,
  store: SimulationStore,
) => (layer: LayerOfKind<K>) => void;

const LAYER_KIND_CONTROLS: { readonly [K in LayerKind]: KindControls<K> } = {
  volume: (folder, layer, store) => {
    const shaded = folder.addCheckbox({
      label: "Phong shading",
      value: layer.shaded,
      onChange: (value) => store.getState().setLayerShading(layer.id, value),
    });
    return (next) => shaded.set(next.shaded);
  },

  slice: (folder, layer, store) => {
    const axis = folder.addSegmented<SliceAxis>({
      label: "Axis",
      value: layer.axis,
      options: SLICE_AXES,
      onChange: (value) => store.getState().setSliceAxis(layer.id, value),
    });
    const position = folder.addSlider({
      label: "Position",
      value: layer.position,
      min: 0,
      max: 1,
      step: 0.005,
      onChange: (value) => store.getState().setSlicePosition(layer.id, value),
    });
    return (next) => {
      axis.set(next.axis);
      position.set(next.position);
    };
  },

  fieldlines: (folder, layer, store) => {
    const seedCount = folder.addSlider({
      label: "Seed count",
      value: seedCountFor(layer),
      min: MIN_SEEDS,
      max: MAX_SEEDS,
      step: 1,
      onChange: (count) => store.getState().setFieldlineSeedCount(layer.id, Math.round(count)),
    });
    const place = folder.addCheckbox({
      label: "Place seeds",
      value: store.getState().seedPlacementLayerId === layer.id,
      onChange: (on) => store.getState().setSeedPlacement(on ? layer.id : null),
    });
    const note = folder.addNote("");
    const reflect = (next: LayerOfKind<"fieldlines">): void => {
      seedCount.set(seedCountFor(next));
      place.set(store.getState().seedPlacementLayerId === next.id);
      applySeedNote(note, next.seeds.length, store.getState().traceNotices[next.id]);
    };
    reflect(layer);
    return reflect;
  },
};

// Build the selected layer's kind-specific controls; the returned function reflects later edits to
// that same layer.
export function buildKindControls(
  folder: Folder,
  layer: Layer,
  store: SimulationStore,
): (next: Layer) => void {
  // `layer.kind` and `layer` are the same discriminated union, but TS cannot correlate an index into
  // the table with the narrowing that index implies — one cast here instead of one per entry.
  const build = LAYER_KIND_CONTROLS[layer.kind] as KindControls<LayerKind>;
  const reflect = build(folder, layer, store);
  return (next) => {
    if (next.kind === layer.kind) reflect(next);
  };
}
