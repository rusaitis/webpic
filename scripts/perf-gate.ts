import type { BrowserContext } from "playwright-core";
import { errorMessage, withPreviewedApp } from "./harness/browserSession.ts";
import { collectPageErrors, waitForFirstFrame } from "./harness/pageProbes.ts";

// Foundation exit gate: cold-start page paint <500 ms; first frame <1500 ms (M2 Pro
// Chrome stable). Builds the production bundle, serves it via `vite preview` (so COOP/COEP
// and the worker chunking match prod), then drives the *installed* Chrome stable —
// headed, because headless WebGPU on macOS/Metal is unreliable (DESIGN §CI). The gate
// is judged on the cold profile; warm is reported for context. Run: `npm run perf:gate`.

const PAGE_PAINT_BUDGET_MS = 500;
const FIRST_FRAME_BUDGET_MS = 1500;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
const WARM_RUNS = 3;

interface FrameMetrics {
  readonly fcpMs: number | null;
  readonly firstFrameMs: number | null;
  readonly crossOriginIsolated: boolean;
  readonly hasWebGpu: boolean;
}

async function measure(context: BrowserContext, url: string): Promise<FrameMetrics> {
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  try {
    await page.goto(url, { waitUntil: "load" });
    await waitForFirstFrame(page, FIRST_FRAME_TIMEOUT_MS);
    return await page.evaluate(() => {
      // Runs in the page; the Node tsconfig lib lacks DOM globals, so read the
      // browser-only fields off a typed view of globalThis.
      const w = globalThis as unknown as {
        performance: {
          getEntriesByType(type: string): ReadonlyArray<{ name: string; startTime: number }>;
          getEntriesByName(name: string): ReadonlyArray<{ startTime: number }>;
        };
        navigator: object;
        crossOriginIsolated?: boolean;
      };
      const paint = w.performance
        .getEntriesByType("paint")
        .find((entry) => entry.name === "first-contentful-paint");
      const firstFrame = w.performance.getEntriesByName("webpic:first-frame")[0];
      return {
        fcpMs: paint ? paint.startTime : null,
        firstFrameMs: firstFrame ? firstFrame.startTime : null,
        crossOriginIsolated: w.crossOriginIsolated === true,
        hasWebGpu: "gpu" in w.navigator,
      };
    });
  } catch (error) {
    const detail = errors.length > 0 ? ` — page errors: ${errors.join(" | ")}` : "";
    throw new Error(`measurement failed at ${url}: ${errorMessage(error)}${detail}`);
  } finally {
    await page.close();
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? Number.NaN)
    : ((sorted[mid - 1] ?? Number.NaN) + (sorted[mid] ?? Number.NaN)) / 2;
}

function fmt(ms: number | null): string {
  return ms === null ? "  n/a" : `${Math.round(ms)} ms`;
}

async function main(): Promise<void> {
  const skipBuild = process.argv.includes("--skip-build");
  if (!skipBuild) console.log("building production bundle…");

  let exitCode = 0;
  try {
    exitCode = await withPreviewedApp(
      async ({ context, baseUrl }) => {
        console.log(`preview server: ${baseUrl}`);

        const cold = await measure(context, baseUrl); // fresh profile → no compiled-pipeline cache
        const warmRuns: FrameMetrics[] = [];
        for (let i = 0; i < WARM_RUNS; i++) warmRuns.push(await measure(context, baseUrl));

        const warmFcp = median(warmRuns.map((m) => m.fcpMs ?? Number.NaN));
        const warmFrame = median(warmRuns.map((m) => m.firstFrameMs ?? Number.NaN));

        const paintPass = cold.fcpMs !== null && cold.fcpMs < PAGE_PAINT_BUDGET_MS;
        const framePass = cold.firstFrameMs !== null && cold.firstFrameMs < FIRST_FRAME_BUDGET_MS;

        console.log("\nwebpic perf gate — Chrome stable, headed, production preview");
        console.log(
          `(this machine is a base Apple M2; the gate targets M2 Pro, so a pass here is conservative)\n`,
        );
        console.log(`  metric        cold        warm(med)   budget      cold`);
        console.log(
          `  page paint    ${fmt(cold.fcpMs).padEnd(11)} ${fmt(warmFcp).padEnd(11)} <${PAGE_PAINT_BUDGET_MS} ms     ${paintPass ? "PASS" : "FAIL"}`,
        );
        console.log(
          `  first frame   ${fmt(cold.firstFrameMs).padEnd(11)} ${fmt(warmFrame).padEnd(11)} <${FIRST_FRAME_BUDGET_MS} ms    ${framePass ? "PASS" : "FAIL"}`,
        );
        console.log(
          `\n  crossOriginIsolated: ${cold.crossOriginIsolated}   navigator.gpu: ${cold.hasWebGpu ? "yes" : "NO"}`,
        );

        if (!cold.hasWebGpu) {
          console.error("\n✖ navigator.gpu absent — WebGPU unavailable in the launched Chrome.");
        }
        if (!paintPass || !framePass) {
          console.error("\n✖ exit gate FAILED on the cold profile.");
          return 1;
        }
        console.log("\n✓ exit gate PASSED on the cold profile.");
        return 0;
      },
      { skipBuild },
    );
  } catch (error) {
    console.error(`\n✖ ${errorMessage(error)}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

void main();
