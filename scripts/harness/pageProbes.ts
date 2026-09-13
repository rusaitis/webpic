import type { Locator, Page } from "playwright-core";

// Page-side probes shared by the headed-Chrome instruments. The `page.evaluate` / `waitForFunction`
// callbacks are serialized into the browser, so they must be self-contained, and they typecheck
// under tsconfig.node.json (no DOM lib) — browser globals are read through minimal typed views.

/** Uncaught exceptions + console errors, collected live; `ignore` drops matching console lines. */
export function collectPageErrors(page: Page, ignore?: RegExp): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !(ignore?.test(msg.text()) ?? false)) errors.push(msg.text());
  });
  return errors;
}

/** Resolves once the render worker has marked its first painted frame (the perf-gate signal). */
export async function waitForFirstFrame(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => performance.getEntriesByName("webpic:first-frame").length > 0,
    undefined,
    { timeout: timeoutMs },
  );
}

export interface DrawingSurface {
  readonly bufferW: number;
  readonly bufferH: number;
  readonly cssW: number;
  readonly cssH: number;
  readonly dpr: number;
  readonly adapter: string;
}

/**
 * GPU adapter + the actual drawing-buffer pixel count — raymarch cost scales per physical pixel, so
 * a ms number is only meaningful alongside it.
 */
export async function readDrawingSurface(page: Page): Promise<DrawingSurface> {
  return page.evaluate(async () => {
    const w = globalThis as unknown as {
      document: {
        querySelector(s: string): {
          getBoundingClientRect(): { width: number; height: number };
        } | null;
      };
      devicePixelRatio: number;
      navigator: { gpu?: { requestAdapter(): Promise<{ info?: unknown } | null> } };
    };
    const canvas = w.document.querySelector("canvas");
    // Read the CSS client box, NOT canvas.width — after transferControlToOffscreen the main-thread
    // placeholder's width/height freeze at their pre-transfer value (256), while the worker owns and
    // sizes the real drawing buffer = clientSize × DPR (viewportTracking). Reconstruct it the same way.
    const rect = canvas?.getBoundingClientRect();
    const cssW = rect ? Math.round(rect.width) : 0;
    const cssH = rect ? Math.round(rect.height) : 0;
    const dpr = w.devicePixelRatio;
    let adapter = "unknown";
    try {
      const a = await w.navigator.gpu?.requestAdapter();
      adapter = a?.info ? JSON.stringify(a.info) : "no-info";
    } catch {
      adapter = "requestAdapter-threw";
    }
    return {
      bufferW: Math.round(cssW * dpr),
      bufferH: Math.round(cssH * dpr),
      cssW,
      cssH,
      dpr,
      adapter,
    };
  });
}

/**
 * Opens the Developer window and ticks the frame-timing "Measure (continuous)" toggle, forcing the
 * sustained-timing loop; returns the readout locator once it shows a real `<n>.<nn> ms` line.
 */
export async function armContinuousTiming(page: Page): Promise<Locator> {
  // The Developer window is closed on boot (it is a dev instrument, not chrome), so open it from
  // the rail before locating its frame-timing pane.
  await page.locator('.webpic-siderail [data-control="diagnostics"]').click();

  // force: the styled SVG box overlays the real <input>; checking the input directly still fires its
  // change handler. Scoped to the Developer window — a docked copy can coexist and makes a bare pane
  // locator ambiguous under strict mode. By data hook, not by title: titles are copy.
  const diagnostics = page
    .locator('[data-window="dev"]')
    .locator('.webpic-pane[data-pane="timing"]');
  await diagnostics.locator(".webpic-checkbox_input").check({ force: true });

  const readout = diagnostics.locator(".webpic-placeholder");
  await page.waitForFunction(
    (element) =>
      /\d+\.\d{2} ms/.test((element as { textContent: string | null }).textContent ?? ""),
    await readout.elementHandle(),
    { timeout: 20_000 },
  );
  return readout;
}

export interface TimingReadout {
  /** The 30-frame rolling mean, or null when the readout has no `<n>.<nn> ms` yet. */
  readonly meanMs: number | null;
  /** Clock label ("" when the readout names neither clock). */
  readonly clock: string;
}

export function parseTimingReadout(text: string): TimingReadout {
  const captured = text.match(/(-?\d+\.\d{2}) ms/)?.[1];
  const meanMs = captured === undefined ? null : Number(captured);
  const clock = text.includes("timestamp-query")
    ? "GPU · timestamp-query"
    : text.includes("wall-clock")
      ? "≈ wall-clock · incl. JS/queue"
      : "";
  return { meanMs, clock };
}
