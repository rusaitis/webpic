import { afterEach, describe, expect, it } from "vitest";
import { createSparkline, FRAME_BUDGET_MS, SPARK_H, SPARK_W } from "./sparkline.ts";

// happy-dom's canvas has no 2D context, so the paint path is unreachable without this stub — which
// is exactly how an infinite recursion in the x mapping once shipped untested.
interface Recorder {
  readonly points: { x: number; y: number }[];
  readonly bands: { x: number; width: number }[];
  readonly labels: string[];
}

function stubCanvasContext(): Recorder {
  const recorder: Recorder = { points: [], bands: [], labels: [] };
  const context = {
    scale() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    stroke() {},
    fill() {},
    moveTo: (x: number, y: number) => recorder.points.push({ x, y }),
    lineTo: (x: number, y: number) => recorder.points.push({ x, y }),
    fillRect: (x: number, _y: number, width: number) => recorder.bands.push({ x, width }),
    fillText: (text: string) => recorder.labels.push(text),
  };
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => context,
  });
  return recorder;
}

afterEach(() => {
  Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
});

describe("createSparkline", () => {
  it("spans the full canvas width from the oldest ring slot to the newest", () => {
    const recorder = stubCanvasContext();
    const sparkline = createSparkline(document, 1);
    for (let i = 0; i < 64; i++) sparkline.push(4, 8);

    sparkline.draw();

    const xs = recorder.points.map((point) => point.x);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(SPARK_W);
  });

  it("paints a background band over each frame that missed the 60 fps budget", () => {
    const recorder = stubCanvasContext();
    const sparkline = createSparkline(document, 1);
    sparkline.push(4, FRAME_BUDGET_MS / 2);
    sparkline.push(4, FRAME_BUDGET_MS * 3);

    sparkline.draw();

    expect(recorder.bands).toHaveLength(1);
    expect(recorder.bands[0]?.width).toBeCloseTo(SPARK_W / 63, 6);
  });

  it("labels the worst frame in the window", () => {
    const recorder = stubCanvasContext();
    const sparkline = createSparkline(document, 1);
    sparkline.push(4, 8);
    sparkline.push(6, 33.4);

    sparkline.draw();

    expect(recorder.labels).toEqual(["33ms"]);
  });

  it("keeps every plotted point inside the canvas height", () => {
    const recorder = stubCanvasContext();
    const sparkline = createSparkline(document, 1);
    sparkline.push(4, 500); // far past the 20 ms floor — the y-scale must follow the peak

    sparkline.draw();

    for (const point of recorder.points) {
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(SPARK_H);
    }
  });
});
