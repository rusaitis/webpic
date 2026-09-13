import { fullRangeWindow, LOG_DECADES, logWindowFloor } from "@schema/colormap.ts";
import { describe, expect, it, vi } from "vitest";

// three/tsl's `uniform()` is the only seam onto what createValueNormalization sends the shader; capture
// each node it mints so the retune assertions can read the values back.
const { createdUniforms } = vi.hoisted(() => ({ createdUniforms: [] as Array<{ value: number }> }));
vi.mock("three/tsl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three/tsl")>();
  return {
    ...actual,
    uniform: (value: number) => {
      const node = actual.uniform(value);
      createdUniforms.push(node as unknown as { value: number });
      return node;
    },
  };
});

import { createValueNormalization, safeWidth, windowedT } from "./normalization.ts";

// uScaleMode's in-shader encoding (normalization.ts `scaleMode`).
const LINEAR_MODE = 0;
const LOG_MODE = 1;
const SYMLOG_MODE = 2;

const uniformValues = (): number[] => createdUniforms.map((u) => u.value);

describe("safeWidth", () => {
  it("floors a collapsed window so the in-shader divide stays finite", () => {
    expect(safeWidth(0)).toBeGreaterThan(0);
    expect(safeWidth(0)).toBe(safeWidth(-0));
  });

  it("takes the magnitude of an inverted window", () => {
    expect(safeWidth(-5)).toBe(5);
  });

  it("passes a normal width through", () => {
    expect(safeWidth(2.5)).toBe(2.5);
  });
});

describe("fullRangeWindow", () => {
  it("centers the field's extent and spans its full range", () => {
    expect(fullRangeWindow({ min: -2, max: 6 })).toEqual({ center: 2, width: 8 });
  });
});

// windowedT is the pure-TS twin the TSL `toT` graph mirrors (rayBox ↔ hitBox precedent). Analytic
// fixtures pin the value→t map per scale; the in-shader graph is built to reproduce these.
describe("windowedT", () => {
  // window {center 5, width 4} → interval [3, 7].
  it("linear maps the window endpoints to 0 / 0.5 / 1", () => {
    expect(windowedT(3, 5, 4, "linear")).toBeCloseTo(0, 12);
    expect(windowedT(5, 5, 4, "linear")).toBeCloseTo(0.5, 12);
    expect(windowedT(7, 5, 4, "linear")).toBeCloseTo(1, 12);
  });

  it("linear saturates outside the window", () => {
    expect(windowedT(0, 5, 4, "linear")).toBe(0);
    expect(windowedT(100, 5, 4, "linear")).toBe(1);
  });

  // window {center 50.5, width 99} → interval [1, 100].
  it("log maps endpoints to 0/1 and the geometric mean to 0.5", () => {
    expect(windowedT(1, 50.5, 99, "log")).toBeCloseTo(0, 6);
    expect(windowedT(100, 50.5, 99, "log")).toBeCloseTo(1, 6);
    expect(windowedT(10, 50.5, 99, "log")).toBeCloseTo(0.5, 6); // sqrt(1·100) = 10
  });

  // window {center 5e3, width 1e4} → interval [0, 1e4]: the full-range window of any field with a
  // vacuum region. Without the decades floor the ε bottom spans ~30 decades and everything lands at
  // t ≈ 1 (the volume renders as a saturated brick).
  it("log anchors a window bottoming at zero LOG_DECADES below its top", () => {
    const floor = logWindowFloor(1e4);
    expect(floor).toBeCloseTo(1e4 * 10 ** -LOG_DECADES, 12);
    expect(windowedT(floor, 5e3, 1e4, "log")).toBeCloseTo(0, 6);
    expect(windowedT(1e4, 5e3, 1e4, "log")).toBeCloseTo(1, 6);
    // Geometric midpoint of [1e-2, 1e4] is 10 — three decades up of six.
    expect(windowedT(10, 5e3, 1e4, "log")).toBeCloseTo(0.5, 6);
    // A real value well inside the range must NOT saturate (the bug this floor fixes).
    expect(windowedT(30, 5e3, 1e4, "log")).toBeLessThan(0.7);
  });

  it("log floors a non-positive input to a finite, saturated t (no NaN)", () => {
    const t = windowedT(0, 50.5, 99, "log");
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBe(0);
  });

  // window {center 0, width 200} → interval [-100, 100], symlog L = 100/100 = 1.
  it("symlog hits 0 / 0.5 / 1 and is odd-symmetric about the center", () => {
    expect(windowedT(-100, 0, 200, "symlog")).toBeCloseTo(0, 6);
    expect(windowedT(0, 0, 200, "symlog")).toBeCloseTo(0.5, 6);
    expect(windowedT(100, 0, 200, "symlog")).toBeCloseTo(1, 6);
    const x = 12.3;
    expect(windowedT(x, 0, 200, "symlog") + windowedT(-x, 0, 200, "symlog")).toBeCloseTo(1, 6);
  });

  it("an explicit linthresh overrides the auto-derived one", () => {
    const withDefault = windowedT(10, 0, 200, "symlog");
    const withL10 = windowedT(10, 0, 200, "symlog", 10);
    expect(withL10).not.toBeCloseTo(withDefault, 3);
  });
});

// The TSL `toT` graph needs a device to evaluate, so the retune contract is read off the uniforms it
// closes over — the three values that actually reach the shader, in construction order.
describe("createValueNormalization", () => {
  it("seeds center/width/mode uniforms from the full range, linear", () => {
    createdUniforms.length = 0;
    createValueNormalization(0, 10);
    expect(uniformValues()).toEqual([5, 10, LINEAR_MODE]);
  });

  it("floors a collapsed width instead of sending 0 to the divide", () => {
    createdUniforms.length = 0;
    const norm = createValueNormalization(0, 10);
    norm.setWindow(5, 0);
    expect(uniformValues()).toEqual([5, safeWidth(0), LINEAR_MODE]);
  });

  it("switches the scale mode in place, leaving the window alone", () => {
    createdUniforms.length = 0;
    const norm = createValueNormalization(0, 10);
    norm.setScale("log");
    expect(uniformValues()).toEqual([5, 10, LOG_MODE]);
    norm.setScale("symlog");
    expect(uniformValues()).toEqual([5, 10, SYMLOG_MODE]);
    norm.setScale("linear");
    expect(uniformValues()).toEqual([5, 10, LINEAR_MODE]);
  });
});
