import type { PerfSample, PerfStore, PerfWorker, UiStore } from "@store";
import { bindChromeVisibility } from "../chromeVisibility.ts";
import { makeEl } from "../controls/dom.ts";
import type { Disposer } from "../controls/index.ts";
import { createShortcutRegistry } from "../keys/shortcuts.ts";
import { createSubscriptions, type Subscriptions } from "../subscriptions.ts";
import {
  CPU_COLOR,
  createSparkline,
  FRAME_30_MS,
  FRAME_BUDGET_MS,
  FRAME_COLOR,
} from "./sparkline.ts";

// Dev-mode performance HUD: a corner meter (top-left, Shift+P) showing FPS + a CPU/frame
// sparkline + VRAM/heap, with an expandable detail panel (memory breakdown, worker topology, main-
// thread jank). It reads perfStore only and dispatches visibility intents — all worker plumbing +
// metric pumps live in app/perfBridge. Self-contained: it injects its own CSS and, while visible,
// redraws on store changes (samples ≤5 Hz) + a slow idle timer — no per-frame rAF, so it never pins
// the main thread and dispatches no intent the bridge forwards (on-demand stays on-demand).

const IDLE_MS = 400; // no new sample within this → the on-demand loop is idle, show "idle" not stale fps
const IDLE_TICK_MS = 250; // idle-flip + detail refresh cadence while visible
const OK_COLOR = "#8fbf8f"; // frame within the 60 fps budget (desaturated green)
const WARN_COLOR = "#f5b050"; // frame within 30 fps (amber); also the band's legend swatch
const BAD_COLOR = "#d98a78"; // frame over the 30 fps budget (soft terracotta)

function formatMs(ms: number): string {
  return Number.isFinite(ms) ? `${ms.toFixed(1)} ms` : "—";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "n/a";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

// Frame-time health: a hue-only tint (never weight/size), and "" for idle/NaN frames. Thresholds
// are the 60/30 fps budgets.
function frameHealthColor(sample: PerfSample | null): string {
  const ms = sample?.frameWallMs ?? Number.NaN;
  if (!Number.isFinite(ms)) return "";
  if (ms <= FRAME_BUDGET_MS) return OK_COLOR;
  if (ms <= FRAME_30_MS) return WARN_COLOR;
  return BAD_COLOR;
}

// Frame-time governor's render-scale ceiling: untinted at full (1), amber on the
// first throttle step, terracotta at the floor — so a thermal/heavy-view throttle is visible at a glance.
function governorColor(scale: number): string {
  if (!Number.isFinite(scale) || scale >= 1) return "";
  return scale >= 0.85 ? WARN_COLOR : BAD_COLOR;
}

export function installPerfHud(
  parent: HTMLElement,
  perfStore: PerfStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const view = doc.defaultView;

  const container = makeEl(doc, "div", "webpic-perf");
  container.hidden = true;

  const head = makeEl(doc, "div", "webpic-perf_head");
  const title = makeEl(doc, "span", "webpic-perf_title");
  title.textContent = "PERF";
  const fpsEl = makeEl(doc, "span", "webpic-perf_fps");
  const caret = makeEl(doc, "button", "webpic-perf_caret");
  caret.type = "button";
  caret.title = "Toggle details";
  caret.addEventListener("click", () => perfStore.getState().togglePerfDetail());
  head.append(title, fpsEl, caret);

  // The frame sparkline owns its rings and its canvas; the HUD only feeds it new samples.
  const sparkline = createSparkline(doc, view?.devicePixelRatio ?? 1);

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

  container.append(head, sparkline.element);

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
    makeKey(WARN_COLOR, "gpu ≈", true),
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

  let lastSeenSample: PerfSample | null = null;
  let lastSampleAtMs = 0;

  const pushIfNewSample = (): void => {
    const sample = perfStore.getState().sample;
    if (sample === null || sample === lastSeenSample) return;
    lastSeenSample = sample;
    lastSampleAtMs = view ? view.performance.now() : 0;
    sparkline.push(sample.cpuEncodeMs, sample.frameWallMs);
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
    const isIdle =
      sample === null || (view ? view.performance.now() - lastSampleAtMs : 0) > IDLE_MS;
    if (isIdle || sample === null || !Number.isFinite(sample.frameIntervalMs)) {
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
    sparkline.draw();
  };

  // Event-driven, not a 60 Hz rAF: while visible, redraw on each new sample + main-heap change, plus a
  // slow timer for the idle flip and detail refresh. `active` holds the visible-only subscriptions,
  // torn down on hide; `idleTimer` doubles as the "am I running?" flag.
  let active: Subscriptions | null = null;
  let idleTimer: number | undefined;

  const startActive = (win: Window): void => {
    lastSeenSample = null; // a re-open re-detects the first sample (idle until one arrives)
    render();
    active = createSubscriptions();
    active.on(perfStore, (s) => s.sample, render);
    active.on(perfStore, (s) => s.mainHeapBytes, render); // heap row would freeze without this
    idleTimer = win.setInterval(() => {
      render(); // re-evaluates the idle → "idle (on-demand)" flip after the last sample
      if (!detail.hidden) renderDetail();
    }, IDLE_TICK_MS);
  };

  const stopActive = (): void => {
    active?.dispose();
    active = null;
    if (idleTimer !== undefined) {
      view?.clearInterval(idleTimer);
      idleTimer = undefined;
    }
  };

  const applyDetail = (open: boolean): void => {
    detail.hidden = !open;
    caret.textContent = open ? "▾" : "▸";
    if (open) renderDetail();
  };
  applyDetail(perfStore.getState().isPerfDetailOpen);

  // Shift+P: the unshifted "P" is ui/install's screenshot, so no conflict.
  const shortcuts = createShortcutRegistry(doc);
  shortcuts.register("p", () => perfStore.getState().togglePerfHud(), { modifiers: "shift" });

  const subscriptions = createSubscriptions();
  const applyVisible = bindChromeVisibility(
    subscriptions,
    uiStore,
    (isVisible) => {
      container.hidden = !isVisible;
      if (isVisible && idleTimer === undefined && view !== null) startActive(view);
      else if (!isVisible && idleTimer !== undefined) stopActive();
    },
    () => perfStore.getState().isPerfHudVisible,
  );
  subscriptions.on(perfStore, (s) => s.isPerfHudVisible, applyVisible);
  subscriptions.on(perfStore, (s) => s.isPerfDetailOpen, applyDetail);

  return () => {
    stopActive();
    subscriptions.dispose();
    shortcuts.dispose();
    container.remove();
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
