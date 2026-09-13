// The control-facade contract: callbacks-out / set()-in, no two-way binding. A control
// never mutates a shared target — it emits edits via `onChange` and reflects external
// (store) changes via `set()`, which never re-fires `onChange`. Handles return a disposer.

import type { ScaleKind } from "./rangeMath.ts";

export type Disposer = () => void;

// One shape for both ends of a control: what a builder returns (`element` is its root node) and
// what a Folder hands back (`element` is the labeled row it appends/removes). `set` reflects a
// store value without echoing onChange.
export interface ControlHandle<T> {
  readonly element: HTMLElement;
  set(value: T): void;
  setDisabled(disabled: boolean): void;
  dispose: Disposer;
}

export interface SelectChoice<V extends string = string> {
  readonly label: string;
  readonly value: V;
}

// A select's option list can change at runtime (e.g. a new dataset's fields); `setOptions`
// rebuilds it and keeps the current value if it survives.
export interface SelectHandle<V extends string> extends ControlHandle<V> {
  setOptions(options: ReadonlyArray<SelectChoice<V>>): void;
}

export interface SliderOptions {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly format?: (value: number) => string;
  readonly onChange: (value: number) => void;
}

export interface SelectOptions<V extends string = string> {
  readonly label: string;
  readonly value: V;
  readonly options: ReadonlyArray<SelectChoice<V>>;
  readonly onChange: (value: V) => void;
}

// A select whose options carry a visual preview: the trigger and each row paint a swatch via the
// injected `paintSwatch` (keeping the generic control free of any colormap dependency). Same
// callback-out/set-in contract as a plain select.
export interface SwatchSelectOptions<V extends string = string> extends SelectOptions<V> {
  readonly paintSwatch: (canvas: HTMLCanvasElement, value: V) => void;
}

// A segmented (sliding-pill) single-select over a small fixed option set: a select's options,
// rendered as N inline radio buttons with a highlight that slides to the active one.
export type SegmentedOptions<V extends string = string> = SelectOptions<V>;

// A range slider emits a single value or an [lo, hi] interval. The window/level control reads
// the interval and converts to the store's {center, width} at the boundary (see rangeMath).
export type RangeValue = number | readonly [number, number];

// The bare widget's construction options. The pane-level RangeControlOptions below is this plus a
// label, and pane.ts passes the object straight through — so they are one type, not two that agree.
export interface RangeWidgetOptions {
  readonly min: number;
  readonly max: number;
  // Single-mode initial value (ignored when `range` is given).
  readonly value?: number;
  // Presence selects interval mode: [lo, hi].
  readonly range?: readonly [number, number];
  // Drag/keyboard granularity only; text entry bypasses it. Omit ⇒ continuous.
  readonly step?: number;
  // Position↔value mapping. Default 'linear'.
  readonly scale?: ScaleKind;
  // symlog linear half-width around 0.
  readonly linthresh?: number;
  // Subtle vertical ticks. `true` derives a count from `step`/scale.
  readonly ticks?: boolean | number;
  // Lighter sub-decade minor ticks on log/symlog. Default on when `ticks`.
  readonly hasMinorTicks?: boolean;
  // Coupled numeric field(s) for precise entry. Default true.
  readonly hasText?: boolean;
  // Value→string for the text field/aria.
  readonly format?: (value: number) => string;
  // Single-mode fill anchor (default min; set 0 for a bipolar field).
  readonly origin?: number;
  // Interval minimum gap (default = step ?? 0); keeps the two ends from collapsing.
  readonly minGap?: number;
  // Live edits during drag/keyboard.
  readonly onInput?: (value: RangeValue) => void;
  // Committed edits on release / text entry.
  readonly onChange?: (value: RangeValue) => void;
}

export interface RangeControlOptions extends RangeWidgetOptions {
  readonly label: string;
  // Required at the pane level: a labeled row exists to report its edits.
  readonly onChange: (value: RangeValue) => void;
}

export interface CheckboxOptions {
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}

// A static, value-less text row (caption / placeholder). No `set`/`setDisabled` — it only
// renders and tears down.
export interface NoteHandle {
  readonly element: HTMLElement;
  dispose(): void;
}

export interface FolderOptions {
  readonly title: string;
}

export interface Folder {
  readonly element: HTMLElement;
  addSlider(options: SliderOptions): ControlHandle<number>;
  addRangeControl(options: RangeControlOptions): ControlHandle<RangeValue>;
  addSelect<V extends string>(options: SelectOptions<V>): SelectHandle<V>;
  addSwatchSelect<V extends string>(options: SwatchSelectOptions<V>): SelectHandle<V>;
  addSegmented<V extends string>(options: SegmentedOptions<V>): ControlHandle<V>;
  addCheckbox(options: CheckboxOptions): ControlHandle<boolean>;
  addFolder(options: FolderOptions): Folder;
  addNote(text: string): NoteHandle;
  dispose(): void;
}

export interface Pane {
  readonly element: HTMLElement;
  addFolder(options: FolderOptions): Folder;
  dispose(): void;
}
