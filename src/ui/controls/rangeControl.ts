// The range slider — webpic's owned window/level primitive. Pure DOM + ./rangeMath (no
// three/scene/framework deps), built off an injected `ownerDocument` so it runs under happy-dom and
// inside an embed iframe. Callbacks-out / set()-in: it emits edits via onInput (live) / onChange
// (commit) and reflects external state via set() without echo. Single or interval (two grips;
// dragging the fill between them moves both ends); `step` quantizes drag + keyboard only, while the
// coupled text field sets a raw value. Pointer Events throughout → touch + desktop share one path.

import { buildRangeDom } from "./rangeDom.ts";
import {
  clamp,
  clampInterval,
  makeScale,
  pointerT,
  type ScaleKind,
  snapToDecade,
  snapToStep,
  stepDecade,
  translateInterval,
} from "./rangeMath.ts";
import type { ControlHandle, RangeValue } from "./types.ts";

type Pair = readonly [number, number];

// The bare widget's construction options (vs the pane-level `RangeControlOptions` in ./types, which
// adds `label` and is structurally a superset passed straight through to createRangeControl).
export interface RangeWidgetOptions {
  readonly min: number;
  readonly max: number;
  // Single-mode initial value (ignored when `range` is given).
  readonly value?: number;
  // Presence selects interval mode: [lo, hi].
  readonly range?: Pair;
  // Drag/keyboard granularity only; text entry bypasses it. Omit ⇒ continuous.
  readonly step?: number;
  // Position↔value mapping. Default 'linear'.
  readonly scale?: ScaleKind;
  // symlog linear half-width around 0.
  readonly linthresh?: number;
  // Subtle vertical ticks. `true` derives a count from `step`/scale.
  readonly ticks?: boolean | number;
  // Lighter sub-decade minor ticks on log/symlog. Default on when `ticks`.
  readonly minorTicks?: boolean;
  // Coupled numeric field(s) for precise entry. Default true.
  readonly text?: boolean;
  // Value→string for the text field/aria.
  readonly format?: (v: number) => string;
  // Single-mode fill anchor (default min; set 0 for a bipolar field).
  readonly origin?: number;
  // Interval minimum gap (default = step ?? 0).
  readonly minGap?: number;
  // Live, during drag/keys.
  readonly onInput?: (v: RangeValue) => void;
  // Commit, on pointer release / text change.
  readonly onChange?: (v: RangeValue) => void;
}

export function createRangeControl(
  doc: Document,
  config: RangeWidgetOptions,
): ControlHandle<RangeValue> {
  const { min, max } = config;
  const step = config.step;
  const initRange = config.range;
  const isInterval = initRange !== undefined;
  const scale = makeScale(
    config.scale ?? "linear",
    min,
    max,
    config.linthresh !== undefined ? { linthresh: config.linthresh } : {},
  );
  const formatter = config.format ?? ((v: number): string => String(v));
  const origin = clamp(config.origin ?? min, min, max);
  const minGap = config.minGap ?? (step && step > 0 ? step : 0);
  const kbStep = step && step > 0 ? step : (max - min) / 100;

  // On log/symlog, drag + keyboard snap to a log-decade grid rather than the uniform `step`.
  // `decadeMinStep` floors it one decade below the symlog linear band so it can't subdivide
  // forever toward 0; log (min > 0) needs no floor. Linear keeps uniform `step`.
  const isLogish = scale.kind === "log" || scale.kind === "symlog";
  const decadeMinStep =
    scale.kind === "symlog" && scale.linthresh > 0
      ? 10 ** (Math.floor(Math.log10(scale.linthresh) + 1e-9) - 1)
      : 0;
  const snapDrag = (raw: number): number =>
    isLogish ? snapToDecade(raw, min, max, decadeMinStep) : snapToStep(raw, min, max, step);
  const snapStep = (raw: number): number => snapToStep(raw, min, max, step);
  const stepN = (cur: number, dir: 1 | -1, n: number): number => {
    let v = cur;
    for (let i = 0; i < n; i++) v = stepDecade(v, dir, min, max, decadeMinStep);
    return v;
  };

  let value = clamp(config.value ?? min, min, max);
  let [lo, hi] = initRange
    ? clampInterval(initRange[0], initRange[1], min, max, minGap)
    : [min, max];

  const { root, track, fill, gripValue, gripLo, gripHi, inputA, inputB } = buildRangeDom(doc, {
    min,
    max,
    isInterval,
    hasText: config.text !== false,
    scale,
    ...(step !== undefined ? { step } : {}),
    ...(config.ticks !== undefined ? { ticks: config.ticks } : {}),
    hasMinorTicks: config.minorTicks !== false && isLogish,
    origin,
  });

  const setGripAria = (g: HTMLElement | null, v: number): void => {
    if (!g) return;
    g.setAttribute("aria-valuenow", String(v));
    g.setAttribute("aria-valuetext", formatter(v));
  };

  function render(): void {
    if (isInterval) {
      track.style.setProperty("--tlo", String(scale.toT(lo)));
      track.style.setProperty("--thi", String(scale.toT(hi)));
      fill.style.setProperty("--fa", String(scale.toT(lo)));
      fill.style.setProperty("--fb", String(scale.toT(hi)));
      setGripAria(gripLo, lo);
      setGripAria(gripHi, hi);
      if (inputA && doc.activeElement !== inputA) inputA.value = formatter(lo);
      if (inputB && doc.activeElement !== inputB) inputB.value = formatter(hi);
    } else {
      const tv = scale.toT(value);
      const t0 = scale.toT(origin);
      track.style.setProperty("--t", String(tv));
      fill.style.setProperty("--fa", String(Math.min(tv, t0)));
      fill.style.setProperty("--fb", String(Math.max(tv, t0)));
      // Square the fill's edge at an interior origin (the 0 baseline); its moving end stays round.
      const interior = origin > min && origin < max;
      if (interior && value !== origin) fill.dataset.origin = value > origin ? "left" : "right";
      else delete fill.dataset.origin;
      setGripAria(gripValue, value);
      if (inputA && doc.activeElement !== inputA) inputA.value = formatter(value);
    }
  }

  const emit = (cb?: (v: RangeValue) => void): void => {
    if (!cb) return;
    cb(isInterval ? [lo, hi] : value);
  };

  type Drag = {
    kind: "value" | "lo" | "hi" | "pan";
    baseLo: number;
    baseHi: number;
    anchor: number;
  };
  let drag: Drag | null = null;
  let dragRect: DOMRect | null = null; // the track box is fixed for a captured drag — measure once

  const valueAt = (clientX: number, rect: DOMRect = track.getBoundingClientRect()): number =>
    scale.toValue(pointerT(clientX, rect));

  const applyGrip = (
    kind: "value" | "lo" | "hi",
    raw: number,
    snap: (r: number) => number = snapDrag,
  ): void => {
    const v = snap(raw);
    if (kind === "value") value = v;
    else if (kind === "lo") lo = clamp(v, min, Math.max(min, hi - minGap));
    else hi = clamp(v, Math.min(max, lo + minGap), max);
  };

  const onDown = (e: PointerEvent): void => {
    if (e.button > 0) return; // left/touch/pen only
    dragRect = track.getBoundingClientRect();
    const raw = valueAt(e.clientX, dragRect);
    const base = { baseLo: lo, baseHi: hi, anchor: raw };
    if (isInterval) {
      // Intent from pointer position, not hit target, so the tall hit band works: grab a grip
      // → drag it; outside [lo,hi] → extend the nearer end; between the grips → pan both.
      if (e.target === gripLo) {
        drag = { kind: "lo", ...base };
      } else if (e.target === gripHi) {
        drag = { kind: "hi", ...base };
      } else if (raw <= lo) {
        applyGrip("lo", raw);
        drag = { kind: "lo", ...base };
        gripLo?.focus();
      } else if (raw >= hi) {
        applyGrip("hi", raw);
        drag = { kind: "hi", ...base };
        gripHi?.focus();
      } else {
        drag = { kind: "pan", ...base };
      }
    } else {
      applyGrip("value", raw);
      drag = { kind: "value", ...base };
      gripValue?.focus();
    }
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      // happy-dom / no-layout environments lack pointer capture — drag still works via events.
    }
    root.classList.add("is-dragging");
    render();
    emit(config.onInput);
    e.preventDefault();
  };

  const onMove = (e: PointerEvent): void => {
    if (!drag) return;
    const rect = dragRect ?? track.getBoundingClientRect();
    if (drag.kind === "pan") {
      const rawDelta = valueAt(e.clientX, rect) - drag.anchor;
      const delta = step && step > 0 ? Math.round(rawDelta / step) * step : rawDelta;
      [lo, hi] = translateInterval(drag.baseLo, drag.baseHi, delta, min, max);
    } else {
      applyGrip(drag.kind, valueAt(e.clientX, rect));
    }
    render();
    emit(config.onInput);
  };

  const onUp = (e: PointerEvent): void => {
    if (!drag) return;
    try {
      track.releasePointerCapture(e.pointerId);
    } catch {
      // already released / never captured
    }
    drag = null;
    dragRect = null;
    root.classList.remove("is-dragging");
    emit(config.onChange);
  };

  const onKey = (e: KeyboardEvent, end: "value" | "lo" | "hi"): void => {
    const cur = end === "lo" ? lo : end === "hi" ? hi : value;
    // On log/symlog the value grip walks the decade grid (Shift = 10 cells); interval ends
    // and linear sliders keep the fine `step` nudge.
    const decade = isLogish && end === "value";
    const mult = e.shiftKey ? 10 : 1;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = decade ? stepN(cur, -1, mult) : cur - kbStep * mult;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = decade ? stepN(cur, 1, mult) : cur + kbStep * mult;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }
    applyGrip(end, next, decade ? snapDrag : snapStep);
    render();
    emit(config.onInput);
    emit(config.onChange);
    e.preventDefault();
  };

  // Text entry clamps without snapping — exact values, unlike the drag/keyboard step grid.
  const onTextA = (): void => {
    const n = Number(inputA?.value);
    if (!Number.isFinite(n)) {
      render();
      return;
    }
    if (isInterval) [lo, hi] = clampInterval(n, hi, min, max, minGap);
    else value = clamp(n, min, max);
    render();
    emit(config.onChange);
  };
  const onTextB = (): void => {
    const n = Number(inputB?.value);
    if (!Number.isFinite(n)) {
      render();
      return;
    }
    [lo, hi] = clampInterval(lo, n, min, max, minGap);
    render();
    emit(config.onChange);
  };

  const ac = new AbortController();
  const { signal } = ac;
  track.addEventListener("pointerdown", onDown, { signal });
  track.addEventListener("pointermove", onMove, { signal });
  track.addEventListener("pointerup", onUp, { signal });
  track.addEventListener("pointercancel", onUp, { signal });
  const grips = [
    [gripValue, "value"],
    [gripLo, "lo"],
    [gripHi, "hi"],
  ] as const;
  for (const [g, end] of grips) g?.addEventListener("keydown", (e) => onKey(e, end), { signal });
  inputA?.addEventListener("change", onTextA, { signal });
  inputB?.addEventListener("change", onTextB, { signal });

  render();

  return {
    element: root,
    set(v) {
      if (isInterval && Array.isArray(v)) [lo, hi] = clampInterval(v[0], v[1], min, max, minGap);
      else if (!isInterval && typeof v === "number") value = clamp(v, min, max);
      render();
    },
    setDisabled(disabled) {
      root.classList.toggle("is-disabled", disabled);
      for (const g of [gripValue, gripLo, gripHi]) {
        if (g) g.tabIndex = disabled ? -1 : 0;
      }
      if (inputA) inputA.disabled = disabled;
      if (inputB) inputB.disabled = disabled;
    },
    dispose() {
      ac.abort();
      root.remove();
    },
  };
}
