import { errorMessage, withPreviewedApp } from "./harness/browserSession.ts";
import {
  armContinuousTiming,
  collectPageErrors,
  parseTimingReadout,
  readDrawingSurface,
  waitForFirstFrame,
} from "./harness/pageProbes.ts";
import { quantile } from "./harness/stats.ts";

// Raymarch perf instrument (not a CI gate): drives real Chrome stable with the `?n=256` synthetic
// override so the auto-seeded volume layer raymarches a full 256³ field at the gate's 256 steps,
// ticks the timing panel's "Measure (continuous)" toggle, and samples the sustained per-frame time the
// panel reports against the 8 ms gate. It measures the *default* (fixed-march) path — empty-space
// skipping is opt-in and default-off (M2.6: it regresses space-filling |B|, helps only sparse data).
// This is the M2 exit-gate / "profile before tuning" instrument. Run on the target GPU:
//   node scripts/profile-raymarch.ts [size]   (size defaults to 256)
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

async function main(): Promise<void> {
  let exitCode = 0;
  try {
    exitCode = await withPreviewedApp(
      async ({ page, baseUrl }) => {
        const errors = collectPageErrors(page);

        await page.goto(`${baseUrl}?n=${SIZE}`, { waitUntil: "load" });
        // The 256³ field is decoded + |B|-computed + uploaded before first frame.
        await waitForFirstFrame(page, 30_000);

        const ctx = await readDrawingSurface(page);
        const readout = await armContinuousTiming(page);

        // Let the rolling mean warm before sampling (a cold first frame ages out of the 30-frame window).
        await page.waitForTimeout(1500);

        const means: number[] = [];
        let clock = "";
        for (let i = 0; i < SAMPLE_COUNT; i++) {
          const reading = parseTimingReadout(await readout.innerText());
          if (reading.meanMs !== null) means.push(reading.meanMs);
          if (reading.clock !== "") clock = reading.clock;
          await page.waitForTimeout(SAMPLE_MS);
        }

        const finite = means.filter(Number.isFinite);
        const sorted = [...finite].sort((a, b) => a - b);
        const min = sorted[0] ?? Number.NaN;
        const max = sorted[sorted.length - 1] ?? Number.NaN;
        const p50 = quantile(sorted, 0.5);
        const last = finite[finite.length - 1] ?? Number.NaN;
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
          `\n  sustained per-frame (30-frame rolling mean, ${finite.length} samples over ~10 s):`,
        );
        console.log(
          `    min ${min.toFixed(2)}   p50 ${p50.toFixed(2)}   max ${max.toFixed(2)}   last ${last.toFixed(2)}  ms`,
        );
        console.log(`\n  gate:       ${GATE_MS} ms/frame`);
        console.log(
          `  verdict:    p50 ${p50.toFixed(2)} ms ${pass ? "≤" : ">"} ${GATE_MS} ms → ${pass ? "PASS (under gate on this surface)" : "OVER gate — needs a gate lever (steps / resolution cap / LOD) or an M2 Pro re-run; empty-space skipping won't help space-filling |B|"}`,
        );
        if (errors.length > 0) console.error(`\n  page errors: ${errors.join(" | ")}`);
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
