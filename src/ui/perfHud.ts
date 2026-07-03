import type { PerfSample, PerfStore, PerfWorker, UiStore } from "@store";
import { makeEl } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";
import { isTypingTarget } from "./keyboard.ts";
import { FALLBACK_BG, FALLBACK_BORDER, FALLBACK_FG } from "./theme/styles.ts";

// Dev-mode performance HUD: a magviz-style corner meter (top-left, Shift+P) showing FPS + a CPU/frame
// sparkline + VRAM/heap, with an expandable detail panel (memory breakdown, worker topology, main-
// thread jank). It reads perfStore only and dispatches visibility intents — all worker plumbing +
// metric pumps live in app/perfBridge. Self-contained: it injects its own CSS and, while visible,
// redraws on store changes (samples ≤5 Hz) + a slow idle timer — no per-frame rAF, so it never pins
// the main thread and dispatches no intent the bridge forwards (on-demand stays on-demand).

const SPARK_LEN = 64; // sparkline ring length (~13 s of samples at 5 Hz)
const IDLE_MS = 400; // no new sample within this → the on-demand loop is idle, show "idle" not stale fps
const IDLE_TICK_MS = 250; // idle-flip + detail refresh cadence while visible (replaces the per-frame rAF)
const FRAME_BUDGET_MS = 1000 / 60; // 60 fps budget — sparkline reference line + frame-health threshold
const FRAME_30_MS = 1000 / 30; // 30 fps — the amber/red frame-health threshold
const SPARK_W = 196;
const SPARK_H = 40;
const CPU_COLOR = "#7ee08a"; // CPU-encode sparkline (green)
const FRAME_COLOR = "#5ad1e6"; // frame wall-clock sparkline (cyan)
const GPU_BAND = "rgba(245, 176, 80, 0.22)"; // ≈ GPU+queue band (frame − cpu), amber fill
const GPU_KEY = "#f5b050"; // the band's legend swatch (opaque amber)
const OK_COLOR = "#8fbf8f"; // frame within the 60 fps budget (desaturated green)
const WARN_COLOR = "#f5b050"; // frame within 30 fps (reuses the amber warning hue)
const BAD_COLOR = "#d98a78"; // frame over the 30 fps budget (soft terracotta)
const WARN_BAND = "rgba(245, 176, 80, 0.13)"; // sparkline bg over 30–60 fps frames (faint amber)
const BAD_BAND = "rgba(217, 138, 120, 0.2)"; // sparkline bg over sub-30 fps frames (faint terracotta)

const HUD_CSS = `
.webpic-perf {
  position: fixed; top: 12px; left: 12px; z-index: 30; width: 220px; padding: 8px 10px;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--webpic-fg, ${FALLBACK_FG}); background: var(--webpic-bg, ${FALLBACK_BG});
  border: 1px solid var(--webpic-border, ${FALLBACK_BORDER}); border-radius: 8px;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); user-select: none;
}
.webpic-perf[hidden] { display: none; }
.webpic-perf_head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; }
.webpic-perf_title { font-weight: 600; letter-spacing: 0.08em; opacity: 0.6; }
.webpic-perf_fps { margin-left: auto; font-variant-numeric: tabular-nums; }
.webpic-perf_caret {
  cursor: pointer; background: none; border: none; color: inherit; font: inherit; padding: 0 2px;
  opacity: 0.6; line-height: 1;
}
.webpic-perf_caret:hover { opacity: 1; }
.webpic-perf_spark { display: block; width: ${SPARK_W}px; height: ${SPARK_H}px; margin: 2px 0 4px; }
.webpic-perf_legend { display: flex; gap: 12px; font-size: 10px; opacity: 0.65; margin: 0 0 6px; }
.webpic-perf_legend > span { display: inline-flex; align-items: center; gap: 5px; }
.webpic-perf_key { display: inline-block; width: 10px; height: 2px; border-radius: 1px; }
.webpic-perf_key.is-fill { height: 7px; opacity: 0.55; }
.webpic-perf_row { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; }
.webpic-perf_row > span:first-child { opacity: 0.55; }
.webpic-perf_detail {
  margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--webpic-border, ${FALLBACK_BORDER});
}
.webpic-perf_detail[hidden] { display: none; }
.webpic-perf_sub {
  opacity: 0.5; text-transform: uppercase; letter-spacing: 0.06em; font-size: 10px; margin: 6px 0 1px;
}
.webpic-perf_clk { opacity: 0.4; font-size: 10px; margin-top: 2px; }
`;

function formatMs(ms: number): string {
  return Number.isFinite(ms) ? `${ms.toFixed(1)} ms` : "—";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "n/a";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

// Frame-time health: a hue-only tint (never weight/size), and "" for idle/NaN frames so they look
// exactly as before. Thresholds are the 60/30 fps budgets.
function frameHealthColor(sample: PerfSample | null): string {
  const ms = sample?.frameWallMs ?? Number.NaN;
  if (!Number.isFinite(ms)) return "";
  if (ms <= FRAME_BUDGET_MS) return OK_COLOR;
  if (ms <= FRAME_30_MS) return WARN_COLOR;
  return BAD_COLOR;
}

// Frame-time governor's render-scale ceiling: untinted at full (1, reads as before), amber on the
// first throttle step, terracotta at the floor — so a thermal/heavy-view throttle is visible at a glance.
function governorColor(scale: number): string {
  if (!Number.isFinite(scale) || scale >= 1) return "";
  return scale >= 0.85 ? WARN_COLOR : BAD_COLOR;
}

// Inject the HUD stylesheet once; the returned disposer removes it (single HUD instance).
function injectStyles(doc: Document): Disposer {
  const style = makeEl(doc, "style", "webpic-perf-style");
  style.textContent = HUD_CSS;
  doc.head.appendChild(style);
  return () => style.remove();
}

export function installPerfHud(
  parent: HTMLElement,
  perfStore: PerfStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const view = doc.defaultView;
  const disposeStyles = injectStyles(doc);

  const container = makeEl(doc, "div", "webpic-perf");
  container.hidden = true;

  const head = makeEl(doc, "div", "webpic-perf_head");
  const title = makeEl(doc, "span", "webpic-perf_title");
  title.textContent = "PERF";
  const fpsEl = makeEl(doc, "span", "webpic-perf_fps");
  const caret = makeEl(doc, "button", "webpic-perf_caret");
  caret.type = "button";
  caret.title = "Toggle details";
  caret.addEventListener("click", () => perfStore.getState().toggleDetail());
  head.append(title, fpsEl, caret);

  const canvas = makeEl(doc, "canvas", "webpic-perf_spark");
  const dpr = view?.devicePixelRatio ?? 1;
  canvas.width = Math.round(SPARK_W * dpr);
  canvas.height = Math.round(SPARK_H * dpr);
  const ctx2d = canvas.getContext("2d");
  ctx2d?.scale(dpr, dpr); // draw in CSS px

  // Compact text rows (label + live value).
  const makeRow = (label: string): HTMLSpanElement => {
    const row = makeEl(doc, "div", "webpic-perf_row");
    const name = makeEl(doc, "span", "");
    name.textContent = label;
    const value = makeEl(doc, "span", "");
    row.append(name, value);
    container.append(row); // appended after the canvas below; reordered via DOM order
    return value;
  };

  container.append(head, canvas);

  // Legend mapping the two sparkline series to their colors (the rows below show only numbers).
  const makeKey = (color: string, label: string, fill = false): HTMLSpanElement => {
    const span = makeEl(doc, "span", "");
    const swatch = makeEl(doc, "i", fill ? "webpic-perf_key is-fill" : "webpic-perf_key");
    swatch.style.background = color;
    span.append(swatch, doc.createTextNode(label));
    return span;
  };
  const legend = makeEl(doc, "div", "webpic-perf_legend");
  legend.append(
    makeKey(CPU_COLOR, "cpu"),
    makeKey(GPU_KEY, "gpu ≈", true),
    makeKey(FRAME_COLOR, "frame"),
  );
  container.append(legend);

  const cpuValue = makeRow("cpu");
  const gpuValue = makeRow("gpu ≈");
  const frameValue = makeRow("frame ≈");
  const governorValue = makeRow("governor");
  const vramValue = makeRow("vram");
  const heapValue = makeRow("heap");

  const detail = makeEl(doc, "div", "webpic-perf_detail");
  detail.hidden = true;
  container.append(detail);
  parent.appendChild(container);

  // Sparkline rings (CPU encode + frame wall-clock), pushed once per NEW sample, drawn every frame.
  const cpuRing = new Float32Array(SPARK_LEN).fill(Number.NaN);
  const frameRing = new Float32Array(SPARK_LEN).fill(Number.NaN);
  let ringIndex = 0;
  let lastSeenSample: PerfSample | null = null;
  let lastSampleAtMs = 0;

  const pushIfNewSample = (): void => {
    const sample = perfStore.getState().sample;
    if (sample === null || sample === lastSeenSample) return;
    lastSeenSample = sample;
    lastSampleAtMs = view ? view.performance.now() : 0;
    cpuRing[ringIndex] = sample.cpuEncodeMs;
    frameRing[ringIndex] = sample.frameWallMs;
    ringIndex = (ringIndex + 1) % SPARK_LEN;
  };

  const drawSeries = (ring: Float32Array, color: string, yMax: number): void => {
    if (ctx2d === null) return;
    ctx2d.beginPath();
    let started = false;
    for (let j = 0; j < SPARK_LEN; j++) {
      const v = ring[(ringIndex + j) % SPARK_LEN];
      if (v === undefined || !Number.isFinite(v)) {
        started = false; // NaN gap — lift the pen
        continue;
      }
      const x = (j / (SPARK_LEN - 1)) * SPARK_W;
      const y = SPARK_H - (Math.min(v, yMax) / yMax) * SPARK_H;
      if (started) ctx2d.lineTo(x, y);
      else ctx2d.moveTo(x, y);
      started = true;
    }
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 1;
    ctx2d.stroke();
  };

  // The ≈ GPU+queue band: the area between the CPU floor and the frame wall-clock (frame − cpu). A
  // derived estimate, not a timestamp — render-pass timestamp-query loses the Metal device, so a true
  // GPU line isn't available (compute passes are timed separately by gpu/profiler). Per-segment fill skips NaN gaps.
  const drawGpuBand = (yMax: number): void => {
    if (ctx2d === null) return;
    ctx2d.fillStyle = GPU_BAND;
    const yOf = (v: number): number => SPARK_H - (Math.min(v, yMax) / yMax) * SPARK_H;
    for (let j = 0; j < SPARK_LEN - 1; j++) {
      const c0 = cpuRing[(ringIndex + j) % SPARK_LEN];
      const w0 = frameRing[(ringIndex + j) % SPARK_LEN];
      const c1 = cpuRing[(ringIndex + j + 1) % SPARK_LEN];
      const w1 = frameRing[(ringIndex + j + 1) % SPARK_LEN];
      if (c0 === undefined || w0 === undefined || c1 === undefined || w1 === undefined) continue;
      if (!Number.isFinite(c0) || !Number.isFinite(w0)) continue;
      if (!Number.isFinite(c1) || !Number.isFinite(w1)) continue;
      const x0 = (j / (SPARK_LEN - 1)) * SPARK_W;
      const x1 = ((j + 1) / (SPARK_LEN - 1)) * SPARK_W;
      ctx2d.beginPath();
      ctx2d.moveTo(x0, yOf(w0));
      ctx2d.lineTo(x1, yOf(w1));
      ctx2d.lineTo(x1, yOf(c1));
      ctx2d.lineTo(x0, yOf(c0));
      ctx2d.closePath();
      ctx2d.fill();
    }
  };

  const drawSparkline = (): void => {
    if (ctx2d === null) return;
    ctx2d.clearRect(0, 0, SPARK_W, SPARK_H);
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
    const segW = SPARK_W / (SPARK_LEN - 1);
    for (let j = 0; j < SPARK_LEN; j++) {
      const v = frameRing[(ringIndex + j) % SPARK_LEN];
      if (v === undefined || !Number.isFinite(v) || v <= FRAME_BUDGET_MS) continue;
      ctx2d.fillStyle = v <= FRAME_30_MS ? WARN_BAND : BAD_BAND;
      ctx2d.fillRect((j / (SPARK_LEN - 1)) * SPARK_W - segW / 2, 0, segW, SPARK_H);
    }
    // 60 fps budget reference.
    const budgetY = SPARK_H - (FRAME_BUDGET_MS / peak) * SPARK_H;
    ctx2d.strokeStyle = "rgba(255,255,255,0.14)";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, budgetY);
    ctx2d.lineTo(SPARK_W, budgetY);
    ctx2d.stroke();
    drawGpuBand(peak); // ≈ GPU+queue fill, under the lines
    drawSeries(frameRing, FRAME_COLOR, peak); // frame wall-clock (cyan)
    drawSeries(cpuRing, CPU_COLOR, peak); // CPU encode (green)
    if (framePeak > 0) {
      ctx2d.fillStyle = "rgba(255,255,255,0.4)"; // matches the _clk note opacity; doubles as the y-max
      ctx2d.font = "9px ui-monospace, monospace";
      ctx2d.textAlign = "right";
      ctx2d.textBaseline = "top";
      ctx2d.fillText(`${Math.round(framePeak)}ms`, SPARK_W - 1, 1);
    }
  };

  const renderDetail = (): void => {
    const state = perfStore.getState();
    const sample = state.sample;
    const rows: string[] = [];
    rows.push('<div class="webpic-perf_sub">memory</div>');
    rows.push(row("main heap", formatBytes(state.mainHeapBytes)));
    rows.push(row("page total", formatBytes(state.pageMemoryBytes)));
    rows.push('<div class="webpic-perf_sub">vram (tracked, est.)</div>');
    if (sample !== null) {
      rows.push(row("total", formatBytes(sample.vramBytes)));
      for (const [key, bytes] of sample.vramByKey ?? []) rows.push(row(key, formatBytes(bytes)));
    }
    rows.push('<div class="webpic-perf_sub">workers</div>');
    for (const w of state.topology) rows.push(workerRow(w));
    rows.push('<div class="webpic-perf_sub">main-thread jank (LoAF)</div>');
    rows.push(
      row(
        "worst",
        state.loaf === null ? "n/a" : `${state.loaf.longestMs.toFixed(0)} ms ×${state.loaf.count}`,
      ),
    );
    rows.push(
      `<div class="webpic-perf_clk">frame ≈ wall-clock · incl. queue + GPU · gpu ≈ frame − cpu (est.)${
        sample?.isContinuous === true ? " · continuous" : ""
      }</div>`,
    );
    detail.innerHTML = rows.join("");
  };

  const render = (): void => {
    pushIfNewSample();
    const state = perfStore.getState();
    const sample = state.sample;
    const idle = sample === null || (view ? view.performance.now() - lastSampleAtMs : 0) > IDLE_MS;
    if (idle || sample === null || !Number.isFinite(sample.frameIntervalMs)) {
      fpsEl.textContent = "idle (on-demand)";
    } else {
      fpsEl.textContent = `${Math.round(1000 / sample.frameIntervalMs)} fps`;
    }
    const gpuEst =
      sample !== null && Number.isFinite(sample.frameWallMs) && Number.isFinite(sample.cpuEncodeMs)
        ? Math.max(0, sample.frameWallMs - sample.cpuEncodeMs)
        : Number.NaN;
    cpuValue.textContent = sample === null ? "—" : formatMs(sample.cpuEncodeMs);
    gpuValue.textContent = formatMs(gpuEst);
    frameValue.textContent = sample === null ? "—" : formatMs(sample.frameWallMs);
    frameValue.style.color = frameHealthColor(sample);
    governorValue.textContent = sample === null ? "—" : `${sample.governorScale.toFixed(2)}×`;
    governorValue.style.color = sample === null ? "" : governorColor(sample.governorScale);
    vramValue.textContent = sample === null ? "—" : formatBytes(sample.vramBytes);
    heapValue.textContent = formatBytes(state.mainHeapBytes);
    drawSparkline();
  };

  // Event-driven, not a 60 Hz rAF: while visible, redraw on each new sample + main-heap change, plus a
  // slow timer for the idle flip and detail refresh. `active` holds the visible-only subscriptions,
  // torn down on hide; `idleTimer` doubles as the "am I running?" flag.
  const active: Disposer[] = [];
  let idleTimer: number | undefined;

  const startActive = (win: Window): void => {
    lastSeenSample = null; // a re-open re-detects the first sample (idle until one arrives)
    render();
    active.push(
      perfStore.subscribe((s) => s.sample, render),
      perfStore.subscribe((s) => s.mainHeapBytes, render), // heap row would freeze without this
    );
    idleTimer = win.setInterval(() => {
      render(); // re-evaluates the idle → "idle (on-demand)" flip after the last sample
      if (!detail.hidden) renderDetail();
    }, IDLE_TICK_MS);
  };

  const stopActive = (): void => {
    for (const dispose of active.splice(0).reverse()) dispose();
    if (idleTimer !== undefined) {
      view?.clearInterval(idleTimer);
      idleTimer = undefined;
    }
  };

  const applyVisible = (): void => {
    const visible = uiStore.getState().isUiVisible && perfStore.getState().isPerfHudVisible;
    container.hidden = !visible;
    if (visible && idleTimer === undefined && view !== null) startActive(view);
    else if (!visible && idleTimer !== undefined) stopActive();
  };

  const applyDetail = (open: boolean): void => {
    detail.hidden = !open;
    caret.textContent = open ? "▾" : "▸";
    if (open) renderDetail();
  };
  applyDetail(perfStore.getState().isPerfDetailOpen);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Shift+P — matches magviz; the bare-modifier UI toggle (F) bails on Shift, so no conflict.
    if (event.shiftKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      perfStore.getState().togglePerfHud();
    }
  };

  applyVisible();
  doc.addEventListener("keydown", onKeyDown);
  const unsubUi = uiStore.subscribe((s) => s.isUiVisible, applyVisible);
  const unsubVisible = perfStore.subscribe((s) => s.isPerfHudVisible, applyVisible);
  const unsubDetail = perfStore.subscribe((s) => s.isPerfDetailOpen, applyDetail);

  return () => {
    stopActive();
    unsubUi();
    unsubVisible();
    unsubDetail();
    doc.removeEventListener("keydown", onKeyDown);
    container.remove();
    disposeStyles();
  };
}

// Small HTML-row helpers for the detail panel (rebuilt on a throttle; the values are short + trusted).
function row(label: string, value: string): string {
  return `<div class="webpic-perf_row"><span>${label}</span><span>${value}</span></div>`;
}

function workerRow(worker: PerfWorker): string {
  const dot = worker.live ? "●" : "○";
  const heap = worker.heapBytes === null ? "" : ` · ${formatBytes(worker.heapBytes)}`;
  const note = worker.note !== undefined ? ` · ${worker.note}` : "";
  return row(
    `${dot} ${worker.role}`,
    `${heap}${note}`.replace(/^ · /, "") || (worker.live ? "live" : "—"),
  );
}
