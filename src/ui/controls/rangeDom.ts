import { makeEl } from "./dom.ts";
import { minorTickPositions, type Scale, tickPositions } from "./rangeMath.ts";

// The range slider's DOM: root → track → fill, an optional tick layer, one or two grips, and the
// optional coupled text fields. Construction only — no listeners, no state. createRangeControl keeps
// the behavior; splitting the building out leaves that body about the gesture, not the markup.

export interface RangeParts {
  readonly root: HTMLElement;
  readonly track: HTMLElement;
  readonly fill: HTMLElement;
  // Single mode has `value`; interval mode has `lo` + `hi`. Never all three.
  readonly gripValue: HTMLDivElement | null;
  readonly gripLo: HTMLDivElement | null;
  readonly gripHi: HTMLDivElement | null;
  readonly inputA: HTMLInputElement | null;
  readonly inputB: HTMLInputElement | null;
}

export interface RangeDomOptions {
  readonly min: number;
  readonly max: number;
  readonly isInterval: boolean;
  readonly hasText: boolean;
  readonly scale: Scale;
  readonly step?: number;
  // `true` derives a tick count from step/scale; a number sets it; absent/false paints none.
  readonly ticks?: boolean | number;
  readonly hasMinorTicks: boolean;
  // Single-mode fill anchor; an interior one always gets its own tick.
  readonly origin: number;
}

// Tick positions in [0,1]: the configured set, plus an always-on mark at an interior fill origin.
function trackTicks(options: RangeDomOptions): { major: number[]; minor: number[] } {
  const major: number[] = [];
  if (options.ticks) {
    const count = typeof options.ticks === "number" ? options.ticks : undefined;
    major.push(
      ...tickPositions(options.scale, {
        ...(options.step !== undefined ? { step: options.step } : {}),
        ...(count !== undefined ? { count } : {}),
      }),
    );
  }
  if (!options.isInterval && options.origin > options.min && options.origin < options.max) {
    const originT = options.scale.toT(options.origin);
    if (!major.some((t) => Math.abs(t - originT) < 1e-6)) major.push(originT);
  }
  const minor =
    options.ticks && options.hasMinorTicks ? [...minorTickPositions(options.scale)] : [];
  return { major, minor };
}

export function buildRangeDom(doc: Document, options: RangeDomOptions): RangeParts {
  const { min, max, isInterval } = options;
  const root = makeEl(doc, "div", "webpic-range");
  root.dataset.mode = isInterval ? "interval" : "single";
  const track = makeEl(doc, "div", "webpic-range_track");
  const fill = makeEl(doc, "div", "webpic-range_fill");
  root.appendChild(track);
  track.appendChild(fill);

  // Ticks paint above the fill so they stay visible over the colored range.
  const { major, minor } = trackTicks(options);
  if (major.length > 0 || minor.length > 0) {
    const layer = makeEl(doc, "div", "webpic-range_ticks");
    for (const t of minor) {
      const mark = makeEl(doc, "div", "webpic-range_tick is-minor");
      mark.style.setProperty("--mt", String(t));
      layer.appendChild(mark);
    }
    for (const t of major) {
      const mark = makeEl(doc, "div", "webpic-range_tick");
      mark.style.setProperty("--mt", String(t));
      layer.appendChild(mark);
    }
    track.appendChild(layer);
  }

  // A focusable <div role="slider">, not an <input>, so bare-key shortcuts (F/C) still reach the
  // document handlers while a grip has focus.
  const makeGrip = (end: "value" | "lo" | "hi"): HTMLDivElement => {
    const grip = makeEl(doc, "div", "webpic-range_grip");
    grip.dataset.end = end;
    grip.tabIndex = 0;
    grip.setAttribute("role", "slider");
    grip.setAttribute("aria-orientation", "horizontal");
    grip.setAttribute("aria-valuemin", String(min));
    grip.setAttribute("aria-valuemax", String(max));
    track.appendChild(grip);
    return grip;
  };

  let inputA: HTMLInputElement | null = null;
  let inputB: HTMLInputElement | null = null;
  if (options.hasText) {
    const wrap = makeEl(doc, "div", "webpic-range_text");
    const makeInput = (): HTMLInputElement => {
      const input = makeEl(doc, "input", "webpic-range_input");
      input.type = "text";
      input.inputMode = "decimal";
      input.spellcheck = false;
      wrap.appendChild(input);
      return input;
    };
    inputA = makeInput();
    if (isInterval) inputB = makeInput();
    root.appendChild(wrap);
  }

  return {
    root,
    track,
    fill,
    gripValue: isInterval ? null : makeGrip("value"),
    gripLo: isInterval ? makeGrip("lo") : null,
    gripHi: isInterval ? makeGrip("hi") : null,
    inputA,
    inputB,
  };
}
