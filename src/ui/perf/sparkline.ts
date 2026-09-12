import { makeEl } from "../controls/dom.ts";

// The perf HUD's frame sparkline: two ring buffers (CPU encode, frame wall-clock) and everything
// that paints them — the ≈GPU+queue band between the two lines, the amber/red bands over
// over-budget stretches, the 60 fps reference line and the window's worst-frame label. Owns its
// canvas so perfHud.ts is left with the DOM rows and the store subscriptions.

const SPARK_LEN = 64; // ring length (~13 s of samples at 5 Hz)
export const SPARK_W = 196;
export const SPARK_H = 40;
const SAMPLE_SPACING = SPARK_W / (SPARK_LEN - 1); // x-advance per ring slot
export const FRAME_BUDGET_MS = 1000 / 60; // 60 fps budget — reference line and frame-health threshold
export const FRAME_30_MS = 1000 / 30; // 30 fps — the amber/red threshold
export const CPU_COLOR = "#7ee08a"; // CPU-encode sparkline (green)
export const FRAME_COLOR = "#5ad1e6"; // frame wall-clock sparkline (cyan)
const GPU_BAND = "rgba(245, 176, 80, 0.22)"; // ≈ GPU+queue band (frame − cpu), amber fill
const WARN_BAND = "rgba(245, 176, 80, 0.13)"; // sparkline bg over 30–60 fps frames (faint amber)
const BAD_BAND = "rgba(217, 138, 120, 0.2)"; // sparkline bg over sub-30 fps frames (faint terracotta)

export interface Sparkline {
  readonly element: HTMLCanvasElement;
  // Append one sample pair to the rings (called once per NEW store sample, not per frame).
  push(cpuEncodeMs: number, frameWallMs: number): void;
  draw(): void;
}

export function createSparkline(doc: Document, devicePixelRatio: number): Sparkline {
  const canvas = makeEl(doc, "canvas", "webpic-perf_spark");
  canvas.width = Math.round(SPARK_W * devicePixelRatio);
  canvas.height = Math.round(SPARK_H * devicePixelRatio);
  // CSS size from the same constants as the backing store — the stylesheet would be a second copy.
  canvas.style.width = `${SPARK_W}px`;
  canvas.style.height = `${SPARK_H}px`;
  const context = canvas.getContext("2d");
  context?.scale(devicePixelRatio, devicePixelRatio); // draw in CSS px

  const cpuRing = new Float32Array(SPARK_LEN).fill(Number.NaN);
  const frameRing = new Float32Array(SPARK_LEN).fill(Number.NaN);
  let ringIndex = 0;

  const xAt = (j: number): number => j * SAMPLE_SPACING;

  const drawSeries = (ring: Float32Array, color: string, yMax: number): void => {
    if (context === null) return;
    context.beginPath();
    let hasStarted = false;
    for (let j = 0; j < SPARK_LEN; j++) {
      const v = ring[(ringIndex + j) % SPARK_LEN];
      if (v === undefined || !Number.isFinite(v)) {
        hasStarted = false; // NaN gap — lift the pen
        continue;
      }
      const x = xAt(j);
      const y = SPARK_H - (Math.min(v, yMax) / yMax) * SPARK_H;
      if (hasStarted) context.lineTo(x, y);
      else context.moveTo(x, y);
      hasStarted = true;
    }
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.stroke();
  };

  // The ≈ GPU+queue band: the area between the CPU floor and the frame wall-clock (frame − cpu). A
  // derived estimate, not a timestamp — render-pass timestamp-query loses the Metal device, so a true
  // GPU line isn't available (compute passes are timed separately by gpu/profiler). Per-segment fill skips NaN gaps.
  const drawGpuBand = (yMax: number): void => {
    if (context === null) return;
    context.fillStyle = GPU_BAND;
    const yOf = (v: number): number => SPARK_H - (Math.min(v, yMax) / yMax) * SPARK_H;
    for (let j = 0; j < SPARK_LEN - 1; j++) {
      const c0 = cpuRing[(ringIndex + j) % SPARK_LEN];
      const w0 = frameRing[(ringIndex + j) % SPARK_LEN];
      const c1 = cpuRing[(ringIndex + j + 1) % SPARK_LEN];
      const w1 = frameRing[(ringIndex + j + 1) % SPARK_LEN];
      if (c0 === undefined || w0 === undefined || c1 === undefined || w1 === undefined) continue;
      if (!Number.isFinite(c0) || !Number.isFinite(w0)) continue;
      if (!Number.isFinite(c1) || !Number.isFinite(w1)) continue;
      const x0 = xAt(j);
      const x1 = xAt(j + 1);
      context.beginPath();
      context.moveTo(x0, yOf(w0));
      context.lineTo(x1, yOf(w1));
      context.lineTo(x1, yOf(c1));
      context.lineTo(x0, yOf(c0));
      context.closePath();
      context.fill();
    }
  };

  const drawSparkline = (): void => {
    if (context === null) return;
    context.clearRect(0, 0, SPARK_W, SPARK_H);
    // Y-scale to the observed peak (min 20 ms) so spikes stay visible and the budget line sits low.
    let peak = 20;
    let framePeak = 0; // worst frame in the window (wall-clock), for the corner label
    for (let i = 0; i < SPARK_LEN; i++) {
      const a = cpuRing[i];
      const b = frameRing[i];
      if (a !== undefined && Number.isFinite(a) && a > peak) peak = a;
      if (b !== undefined && Number.isFinite(b)) {
        if (b > peak) peak = b;
        if (b > framePeak) framePeak = b;
      }
    }
    // Background highlight over time-regions that missed the 60 fps budget — amber for 30–60 fps,
    // red below 30 — so over-budget stretches read at a glance, not just the latest value.
    for (let j = 0; j < SPARK_LEN; j++) {
      const v = frameRing[(ringIndex + j) % SPARK_LEN];
      if (v === undefined || !Number.isFinite(v) || v <= FRAME_BUDGET_MS) continue;
      context.fillStyle = v <= FRAME_30_MS ? WARN_BAND : BAD_BAND;
      context.fillRect(xAt(j) - SAMPLE_SPACING / 2, 0, SAMPLE_SPACING, SPARK_H);
    }
    // 60 fps budget reference.
    const budgetY = SPARK_H - (FRAME_BUDGET_MS / peak) * SPARK_H;
    context.strokeStyle = "rgba(255,255,255,0.14)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, budgetY);
    context.lineTo(SPARK_W, budgetY);
    context.stroke();
    drawGpuBand(peak); // ≈ GPU+queue fill, under the lines
    drawSeries(frameRing, FRAME_COLOR, peak); // frame wall-clock (cyan)
    drawSeries(cpuRing, CPU_COLOR, peak); // CPU encode (green)
    if (framePeak > 0) {
      context.fillStyle = "rgba(255,255,255,0.4)"; // matches the _clk note opacity; doubles as the y-max
      context.font = "9px ui-monospace, monospace";
      context.textAlign = "right";
      context.textBaseline = "top";
      context.fillText(`${Math.round(framePeak)}ms`, SPARK_W - 1, 1);
    }
  };

  return {
    element: canvas,
    push(cpuEncodeMs, frameWallMs) {
      cpuRing[ringIndex] = cpuEncodeMs;
      frameRing[ringIndex] = frameWallMs;
      ringIndex = (ringIndex + 1) % SPARK_LEN;
    },
    draw: drawSparkline,
  };
}
