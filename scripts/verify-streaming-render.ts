import { errorMessage, withPreviewedApp } from "./harness/browserSession.ts";
import {
  armContinuousTiming,
  collectPageErrors,
  parseTimingReadout,
  readDrawingSurface,
  waitForFirstFrame,
} from "./harness/pageProbes.ts";
import { summarize } from "./harness/stats.ts";

// Manual verification instrument (not a CI gate): drives real Chrome stable, ticks the timing panel's
// "Measure (continuous)" toggle, and scrubs the time control back and forth on a synthetic
// multi-step source while sampling the panel's sustained raymarch ms against the 8 ms gate. It
// covers the GPU-observable behavior the node/dom tests can't:
//   1. the rendered frame changes across the scrub → a streamed timestep's scalar reaches the GPU
//      (scene.setField uploads + re-binds on the live device);
//   2. the panel reports a sustained per-frame number during the scrub → the M2 exit-gate instrument,
//      read against the 8 ms gate (the task's literal "read raymarch ms against the gate");
//   3. the main thread stays responsive → the read + |B| compute stay off-main (the M2.10a guarantee).
// Run on the target GPU: `node scripts/verify-streaming-render.ts [size]` (size defaults to 256).
//
// What this CAN'T prove (by design): that the swap took the in-place ping-pong path rather than a
// per-step scene rebuild. Both render the new field, so (1) is rebuild-agnostic; the rebuild runs on
// the *render worker*, so its stall never shows as a main-thread `longtask` in (3); and three caches
// pipelines by shader hash, so a rebuilt identical-config scene wouldn't even recompile after boot —
// wall-clock can't separate them. The in-place-vs-rebuild discrimination lives in the unit test
// (src/render/worker.streaming.test.ts asserts scene.setField is called, with no second createScene).
//
// The clock is wall-clock (render-pass timestamp-query was removed — it loses the Metal device), so
// the ms over-reads true GPU time. This machine is a base M2; the 8 ms gate targets M2 Pro, so a
// sub-gate result here is conservative and an over-gate one is ambiguous (needs an M2 Pro re-run) —
// the same caveat as scripts/profile-raymarch.ts. PASS/FAIL hinges on the render-side streaming
// behaving (frame changes, main responsive, no errors); the absolute gate is reported, not gated.

const SIZE = Number.parseInt(process.argv[2] ?? "256", 10) || 256;
const GATE_MS = 8;
const SCRUB_DWELL_MS = 160; // per step: enough for the off-main read + stream + swap, several frames
const SCRUB_PRESSES = 60; // ~10 s of sustained bouncing scrub across the step domain
const LONGTASK_BUDGET_MS = 120; // a responsive main thread during scrub stays well under this
const WINDOW = "1440,900"; // fixed window so the drawing-buffer pixel count is reproducible

async function main(): Promise<void> {
  let exitCode = 0;
  try {
    exitCode = await withPreviewedApp(
      async ({ page, baseUrl }) => {
        // Console errors catch three/WebGPU validation faults — but skip the browser's default
        // /favicon.ico (and any other) resource 404, which is benign network noise, not a fault.
        const errors = collectPageErrors(page, /Failed to load resource/i);

        await page.goto(`${baseUrl}?n=${SIZE}`, { waitUntil: "load" });
        // The SIZE³ field is decoded + |B|-computed + uploaded before first frame.
        await waitForFirstFrame(page, 30_000);

        const ctx = await readDrawingSurface(page);

        // Record long tasks from here on — first-frame compile/upload longtasks are already past.
        await page.evaluate(() => {
          const w = globalThis as unknown as { __longtasks: number[] };
          w.__longtasks = [];
          const Observer = (
            globalThis as unknown as {
              PerformanceObserver: new (
                cb: (list: { getEntries: () => Array<{ duration: number }> }) => void,
              ) => { observe: (init: { entryTypes: string[] }) => void };
            }
          ).PerformanceObserver;
          new Observer((list) => {
            for (const entry of list.getEntries()) w.__longtasks.push(entry.duration);
          }).observe({ entryTypes: ["longtask"] });
        });

        // Scope to the render canvas — the colorbar + colormap-swatch add their own <canvas> elements, so a
        // bare "canvas" locator is ambiguous under Playwright strict mode.
        const canvas = page.locator("#app canvas");
        const before = await canvas.screenshot();

        const readout = await armContinuousTiming(page);

        // Sustained bouncing scrub across the step domain, sampling the rolling-mean readout as we go. The
        // time control moved from a docked pane into the top bar: a chip revealing a popover with prev/next
        // step buttons. Hover the chip to reveal the popover, then click step-next/prev — each dispatches
        // setStep → setCursor → off-main read+compute → streamStep → scene.setField ping-pong. The
        // continuous loop times every frame meanwhile.
        const timeWrap = page.locator(".webpic-topbar_time");
        const nextBtn = page.locator('[data-control="step-next"]');
        const prevBtn = page.locator('[data-control="step-prev"]');
        const readings: number[] = [];
        let clock = "";
        let dir = 1;
        for (let i = 0; i < SCRUB_PRESSES; i++) {
          await timeWrap.hover(); // keep the reveal-on-hover popover open
          await (dir > 0 ? nextBtn : prevBtn).click({ force: true });
          await page.waitForTimeout(SCRUB_DWELL_MS);
          const reading = parseTimingReadout(await readout.innerText());
          if (reading.meanMs !== null && i >= 6) readings.push(reading.meanMs); // drop the first ~1 s while the mean warms
          if (reading.clock !== "") clock = reading.clock;
          // Bounce at the domain ends so the scrub keeps swapping textures rather than parking.
          if (i > 0 && i % 14 === 0) dir = -dir;
        }

        const after = await canvas.screenshot();
        const changed = !after.equals(before);

        const longtasks = await page.evaluate(
          () => (globalThis as unknown as { __longtasks: number[] }).__longtasks,
        );
        const maxLongTask = longtasks.length > 0 ? Math.max(...longtasks) : 0;
        const mainResponsive = maxLongTask < LONGTASK_BUDGET_MS;

        const { min, max, p50, count } = summarize(readings);
        const underGate = Number.isFinite(p50) && p50 <= GATE_MS;
        const megaPixels = (ctx.bufferW * ctx.bufferH) / 1e6;

        console.log(
          "\nwebpic streaming render-side profile — Chrome stable, headed, production preview",
        );
        console.log(
          "(base Apple M2; the M2 gate targets M2 Pro — a sub-gate reading here is conservative)\n",
        );
        console.log(`  workload:   ${SIZE}³ synthetic |B| · 256 steps/ray · sustained scrub`);
        console.log(
          `  surface:    ${ctx.bufferW}×${ctx.bufferH} px (${megaPixels.toFixed(2)} MP · dpr ${ctx.dpr})`,
        );
        console.log(`  adapter:    ${ctx.adapter}`);
        console.log(`  clock:      ${clock || "unknown"}`);
        console.log(`\n  sustained per-frame during scrub (rolling mean, ${count} samples):`);
        console.log(
          `    min ${min.toFixed(2)}   p50 ${p50.toFixed(2)}   max ${max.toFixed(2)}  ms`,
        );
        console.log(`  gate:       ${GATE_MS} ms/frame → p50 ${underGate ? "≤" : ">"} gate`);
        console.log("\n  render-side streaming checks:");
        console.log(
          `    frame changed across scrub:   ${changed ? "yes" : "NO"}  (streamed step reaches GPU)`,
        );
        console.log(
          `    long tasks during scrub:      ${longtasks.length} (max ${maxLongTask.toFixed(1)} ms)`,
        );
        console.log(`    main stayed responsive:       ${mainResponsive ? "yes" : "NO"}`);
        if (errors.length > 0) console.error(`  page errors: ${errors.join(" | ")}`);

        // PASS hinges on the render-side streaming behaving — the streamed step reaches the GPU, the main
        // thread stays responsive (M2.10a off-main), and no faults fire. The absolute gate is reported (an
        // M2 Pro concern), not gated on this base-M2 box. Whether the swap took the in-place ping-pong vs a
        // rebuild is the unit test's call (see the header) — this script can't and doesn't assert it.
        if (!changed || !mainResponsive || errors.length > 0) {
          console.error("\n✖ render-side streaming did not behave as expected.");
          return 1;
        }
        console.log(
          `\n✓ streamed steps reach the GPU across a sustained scrub, main responsive; p50 ${p50.toFixed(2)} ms${
            underGate
              ? " (under gate)"
              : " (over gate — M2 Pro re-run / gate lever, per the exit gate)"
          }.`,
        );
        return 0;
      },
      { chromeArgs: [`--window-size=${WINDOW}`] },
    );
  } catch (error) {
    console.error(`\n✖ ${errorMessage(error)}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

void main();
