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
  createRangeQuantizer,
  grabForPress,
  makeScale,
  pointerT,
  translateInterval,
} from "./rangeMath.ts";
import type { ControlHandle, RangeValue, RangeWidgetOptions } from "./types.ts";

export function createRangeControl(
  doc: Document,
  options: RangeWidgetOptions,
): ControlHandle<RangeValue> {
  const { min, max } = options;
  const step = options.step;
  const initRange = options.range;
  const isInterval = initRange !== undefined;
  const scale = makeScale(
    options.scale ?? "linear",
    min,
    max,
    options.linthresh !== undefined ? { linthresh: options.linthresh } : {},
  );
  const formatter = options.format ?? ((v: number): string => String(v));
  const origin = clamp(options.origin ?? min, min, max);
  const minGap = options.minGap ?? (step && step > 0 ? step : 0);
  const { snapDrag, snapStep, stepDecades, keyStep, isLogish } = createRangeQuantizer(
    scale,
    min,
    max,
    step,
  );

  let value = clamp(options.value ?? min, min, max);
  let [lo, hi] = initRange
    ? clampInterval(initRange[0], initRange[1], min, max, minGap)
    : [min, max];

  const { root, track, fill, gripValue, gripLo, gripHi, inputA, inputB } = buildRangeDom(doc, {
    min,
    max,
    isInterval,
    hasText: options.hasText !== false,
    scale,
    ...(step !== undefined ? { step } : {}),
    ...(options.ticks !== undefined ? { ticks: options.ticks } : {}),
    hasMinorTicks: options.hasMinorTicks !== false && isLogish,
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
      const isInteriorOrigin = origin > min && origin < max;
      if (isInteriorOrigin && value !== origin)
        fill.dataset.origin = value > origin ? "left" : "right";
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

  const onDown = (event: PointerEvent): void => {
    if (event.button > 0) return; // left/touch/pen only
    dragRect = track.getBoundingClientRect();
    const raw = valueAt(event.clientX, dragRect);
    const onGrip = event.target === gripLo ? "lo" : event.target === gripHi ? "hi" : null;
    const kind = grabForPress(raw, lo, hi, isInterval, onGrip);
    drag = { kind, baseLo: lo, baseHi: hi, anchor: raw };
    // A press already on a grip just starts dragging it; anywhere else on the track also jumps the
    // grabbed end to the press and takes focus, so the keyboard continues from where the eye is.
    if (onGrip === null && kind !== "pan") {
      applyGrip(kind, raw);
      (kind === "lo" ? gripLo : kind === "hi" ? gripHi : gripValue)?.focus();
    }
    try {
      track.setPointerCapture(event.pointerId);
    } catch {
      // happy-dom / no-layout environments lack pointer capture — drag still works via events.
    }
    root.classList.add("is-dragging");
    render();
    emit(options.onInput);
    event.preventDefault();
  };

  const onMove = (event: PointerEvent): void => {
    if (!drag) return;
    const rect = dragRect ?? track.getBoundingClientRect();
    if (drag.kind === "pan") {
      const rawDelta = valueAt(event.clientX, rect) - drag.anchor;
      const delta = step && step > 0 ? Math.round(rawDelta / step) * step : rawDelta;
      [lo, hi] = translateInterval(drag.baseLo, drag.baseHi, delta, min, max);
    } else {
      applyGrip(drag.kind, valueAt(event.clientX, rect));
    }
    render();
    emit(options.onInput);
  };

  const onUp = (event: PointerEvent): void => {
    if (!drag) return;
    try {
      track.releasePointerCapture(event.pointerId);
    } catch {
      // already released / never captured
    }
    drag = null;
    dragRect = null;
    root.classList.remove("is-dragging");
    emit(options.onChange);
  };

  const onKey = (event: KeyboardEvent, end: "value" | "lo" | "hi"): void => {
    const cur = end === "lo" ? lo : end === "hi" ? hi : value;
    // On log/symlog the value grip walks the decade grid (Shift = 10 cells); interval ends
    // and linear sliders keep the fine `step` nudge.
    const isDecadeStep = isLogish && end === "value";
    const mult = event.shiftKey ? 10 : 1;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = isDecadeStep ? stepDecades(cur, -1, mult) : cur - keyStep * mult;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = isDecadeStep ? stepDecades(cur, 1, mult) : cur + keyStep * mult;
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
    applyGrip(end, next, isDecadeStep ? snapDrag : snapStep);
    render();
    emit(options.onInput);
    emit(options.onChange);
    event.preventDefault();
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
    emit(options.onChange);
  };
  const onTextB = (): void => {
    const n = Number(inputB?.value);
    if (!Number.isFinite(n)) {
      render();
      return;
    }
    [lo, hi] = clampInterval(lo, n, min, max, minGap);
    render();
    emit(options.onChange);
  };

  const abortController = new AbortController();
  const { signal } = abortController;
  track.addEventListener("pointerdown", onDown, { signal });
  track.addEventListener("pointermove", onMove, { signal });
  track.addEventListener("pointerup", onUp, { signal });
  track.addEventListener("pointercancel", onUp, { signal });
  const grips = [
    [gripValue, "value"],
    [gripLo, "lo"],
    [gripHi, "hi"],
  ] as const;
  for (const [g, end] of grips)
    g?.addEventListener("keydown", (event) => onKey(event, end), { signal });
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
      abortController.abort();
      root.remove();
    },
  };
}
