import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

// Raymarch perf instrument (not a CI gate): drives real Chrome stable with the `?n=256` synthetic
// override so the auto-seeded volume layer raymarches a full 256³ field at the gate's 256 steps,
// ticks the diagnostics "Measure (continuous)" toggle, and samples the sustained per-frame time the
// panel reports against the 8 ms gate. It measures the *default* (fixed-march) path — empty-space
// skipping is opt-in and default-off (M2.6: it regresses space-filling |B|, helps only sparse data).
// This is the M2 exit-gate / "profile before tuning" instrument. Run on the target GPU:
//   npx tsx scripts/profile-raymarch.ts [size]   (size defaults to 256)
//
// The clock is wall-clock (render-pass timestamp-query was removed — it loses the Metal device), so
// the reading includes JS/queue latency and *over-reads* true GPU time: a sub-gate result here is a
// conservative pass. This machine is a base M2; the gate targets M2 Pro, so a pass is doubly safe
// (slower GPU clearing the bar) while a fail is ambiguous and warrants the M2 Pro re-run.

const SIZE = Number.parseInt(process.argv[2] ?? "256", 10) || 256;
const GATE_MS = 8;
const SAMPLE_MS = 250; // poll cadence for the rolling-mean readout
const SAMPLE_COUNT = 40; // ~10 s of sustained measurement once the loop is warm
const WINDOW = "1440,900"; // fixed window so the drawing-buffer pixel count is reproducible

interface Reading {
  readonly meanMs: number;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? Number.NaN;
  const b = sorted[hi] ?? Number.NaN;
  return a + (b - a) * (pos - lo);
}

async function main(): Promise<void> {
  await build({ logLevel: "warn" });
  const server = await preview({ preview: { port: 0 } });
  const url = server.resolvedUrls?.local?.[0];
  if (url === undefined) throw new Error("vite preview did not resolve a local URL");

  const profileDir = await mkdtemp(join(tmpdir(), "webpic-raymarch-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false, // real GPU: WebGPU on macOS/Metal is unreliable headless
    args: ["--no-first-run", "--no-default-browser-check", `--window-size=${WINDOW}`],
  });

  let exitCode = 0;
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto(`${url}?n=${SIZE}`, { waitUntil: "load" });
    await page.waitForFunction(
      () => performance.getEntriesByName("webpic:first-frame").length > 0,
      undefined,
      { timeout: 30_000 }, // the 256³ field is decoded + |B|-computed + uploaded before first frame
    );

    // Record the workload context: GPU adapter + the actual drawing-buffer pixel count (raymarch
    // cost scales per physical pixel, so the ms number is only meaningful alongside it).
    const ctx = await page.evaluate(async () => {
      const w = globalThis as unknown as {
        // Structural (not DOM-lib `Element`) — this file typechecks under tsconfig.node.json (no DOM lib).
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

    // Tick "Measure (continuous)" to force the sustained-timing loop. force: the styled SVG box
    // overlays the real <input>; checking the input directly still fires its change handler.
    await page
      .locator(".webpic-pane", { hasText: "Diagnostics" })
      .locator(".webpic-checkbox_input")
      .check({ force: true });

    const readout = page
      .locator(".webpic-pane", { hasText: "Diagnostics" })
      .locator(".webpic-placeholder");
    await page.waitForFunction(
      (el) => /\d+\.\d{2} ms/.test((el as { textContent: string | null }).textContent ?? ""),
      await readout.elementHandle(),
      { timeout: 20_000 },
    );

    // Let the rolling mean warm before sampling (a cold first frame ages out of the 30-frame window).
    await page.waitForTimeout(1500);

    const readings: Reading[] = [];
    let clock = "";
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const text = await readout.innerText();
      const m = text.match(/(-?\d+\.\d{2}) ms/);
      if (m) readings.push({ meanMs: Number(m[1]) });
      if (text.includes("timestamp-query")) clock = "GPU · timestamp-query";
      else if (text.includes("wall-clock")) clock = "≈ wall-clock · incl. JS/queue";
      await page.waitForTimeout(SAMPLE_MS);
    }

    const means = readings.map((r) => r.meanMs).filter(Number.isFinite);
    const sorted = [...means].sort((a, b) => a - b);
    const min = sorted[0] ?? Number.NaN;
    const max = sorted[sorted.length - 1] ?? Number.NaN;
    const p50 = quantile(sorted, 0.5);
    const last = means[means.length - 1] ?? Number.NaN;
    const pass = Number.isFinite(p50) && p50 <= GATE_MS;

    const megaPixels = (ctx.bufferW * ctx.bufferH) / 1e6;
    console.log("\nwebpic raymarch profile — Chrome stable, headed, production preview");
    console.log(`(base Apple M2; the M2 gate targets M2 Pro — a pass here is conservative)\n`);
    console.log(`  workload:   ${SIZE}³ synthetic |B| volume · 256 steps/ray · early-α 0.98`);
    console.log(
      `  surface:    ${ctx.bufferW}×${ctx.bufferH} px buffer (${megaPixels.toFixed(2)} MP · ${ctx.cssW}×${ctx.cssH} css · dpr ${ctx.dpr})`,
    );
    console.log(`  adapter:    ${ctx.adapter}`);
    console.log(`  clock:      ${clock || "unknown"}`);
    console.log(
      `\n  sustained per-frame (30-frame rolling mean, ${means.length} samples over ~10 s):`,
    );
    console.log(
      `    min ${min.toFixed(2)}   p50 ${p50.toFixed(2)}   max ${max.toFixed(2)}   last ${last.toFixed(2)}  ms`,
    );
    console.log(`\n  gate:       ${GATE_MS} ms/frame`);
    console.log(
      `  verdict:    p50 ${p50.toFixed(2)} ms ${pass ? "≤" : ">"} ${GATE_MS} ms → ${pass ? "PASS (under gate on this surface)" : "OVER gate — needs a gate lever (steps / resolution cap / LOD) or an M2 Pro re-run; empty-space skipping won't help space-filling |B|"}`,
    );
    if (errors.length > 0) console.error(`\n  page errors: ${errors.join(" | ")}`);

    await page.close();
  } catch (error) {
    console.error(`\n✖ ${(error as Error).message}`);
    exitCode = 1;
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
    await rm(profileDir, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

void main();
