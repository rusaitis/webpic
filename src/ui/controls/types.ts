// The control-facade contract: callbacks-out / set()-in, no two-way binding. A control
// never mutates a shared target — it emits edits via `onChange` and reflects external
// (store) changes via `set()`, which never re-fires `onChange`. Handles return a disposer.

export type Disposer = () => void;

// `element` is the labeled row (the shell appends/removes whole rows); `set` reflects a
// store value without echoing onChange.
export interface ControlHandle<T> {
  readonly element: HTMLElement;
  set(value: T): void;
  setDisabled(disabled: boolean): void;
  dispose(): void;
}

// A control builder's root node + set/dispose seam; the Folder wraps it in a labeled row.
export interface Widget<T> {
  readonly element: HTMLElement;
  set(value: T): void;
  setDisabled(disabled: boolean): void;
  dispose: Disposer;
}

export interface SelectOption<V extends string = string> {
  readonly label: string;
  readonly value: V;
}

// A select's option list can change at runtime (e.g. a new dataset's fields); `setOptions`
// rebuilds it and keeps the current value if it survives. The handle is a select-specific
// `ControlHandle` so callers that need this stay typed.
export interface SelectWidget<V extends string> extends Widget<V> {
  setOptions(options: ReadonlyArray<SelectOption<V>>): void;
}

export interface SelectHandle<V extends string> extends ControlHandle<V> {
  setOptions(options: ReadonlyArray<SelectOption<V>>): void;
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
  readonly options: ReadonlyArray<SelectOption<V>>;
  readonly onChange: (value: V) => void;
}

export interface CheckboxOptions {
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}

export interface TextOptions {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export interface ButtonOptions {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

export interface ButtonHandle {
  readonly element: HTMLElement;
  setDisabled(disabled: boolean): void;
  dispose(): void;
}

// A static, value-less text row (caption / placeholder). No `set`/`setDisabled` — it only
// renders and tears down.
export interface NoteHandle {
  readonly element: HTMLElement;
  dispose(): void;
}

export interface FolderOptions {
  readonly title: string;
  readonly expanded?: boolean;
}

export interface Folder {
  readonly element: HTMLElement;
  addSlider(opts: SliderOptions): ControlHandle<number>;
  addSelect<V extends string>(opts: SelectOptions<V>): SelectHandle<V>;
  addCheckbox(opts: CheckboxOptions): ControlHandle<boolean>;
  addText(opts: TextOptions): ControlHandle<string>;
  addButton(opts: ButtonOptions): ButtonHandle;
  addFolder(opts: FolderOptions): Folder;
  addNote(text: string): NoteHandle;
  dispose(): void;
}

export interface Pane {
  readonly element: HTMLElement;
  addFolder(opts: FolderOptions): Folder;
  dispose(): void;
}
