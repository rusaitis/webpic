import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

// One-off M2.10a verification (not a CI gate): drives real Chrome stable, scrubs the time control on
// a 128³ synthetic multi-step source, and confirms the two integrations the node/dom tests can't:
//   1. the rendered frame changes per step  → the streamed scalar reaches the GPU (data → render
//      over the paired MessagePort, no main hop);
//   2. no long main-thread task fires during the scrub → the per-step read + |B| compute run OFF the
//      main thread in the data worker (a 128³ computeField on main would be a clear long task).
// Run: `npx tsx scripts/verify-streaming.ts`.

const N = 128; // big enough that an on-main compute would trip a long task; small enough to stay snappy
const SCRUB_STEPS = 4;
const LONGTASK_BUDGET_MS = 120; // a responsive main thread during scrub stays well under this

async function main(): Promise<void> {
  await build({ logLevel: "warn" });
  const server = await preview({ preview: { port: 0 } });
  const url = server.resolvedUrls?.local?.[0];
  if (url === undefined) throw new Error("vite preview did not resolve a local URL");

  const profileDir = await mkdtemp(join(tmpdir(), "webpic-stream-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  let exitCode = 0;
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${url}?n=${N}`, { waitUntil: "load" });
    await page.waitForFunction(
      () => performance.getEntriesByName("webpic:first-frame").length > 0,
      undefined,
      { timeout: 20_000 },
    );

    // Record long tasks from here on — first-frame compile/upload longtasks are already past. The
    // browser APIs are cast to minimal local shapes (this callback is typechecked under the Node
    // tsconfig, which has no DOM `window` / "longtask" EntryType).
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

    const canvas = page.locator("canvas");
    const frameAt = async (): Promise<Buffer> => canvas.screenshot();
    const before = await frameAt();

    // Scrub the time control forward a few steps (each ArrowRight = +1 index → setStep → stream).
    const grip = page.locator('.webpic-pane:has-text("Time") .webpic-range_grip');
    await grip.focus();
    for (let i = 0; i < SCRUB_STEPS; i++) {
      await grip.press("ArrowRight");
      await page.waitForTimeout(350); // let the off-main read + stream + swap land
    }

    // Poll for the rendered frame to differ from step 0 (the stream is async).
    let changed = false;
    for (let i = 0; i < 12 && !changed; i++) {
      changed = !(await frameAt()).equals(before);
      if (!changed) await page.waitForTimeout(250);
    }

    const longtasks = await page.evaluate(
      () => (globalThis as unknown as { __longtasks: number[] }).__longtasks,
    );
    const maxLongTask = longtasks.length > 0 ? Math.max(...longtasks) : 0;
    const mainResponsive = maxLongTask < LONGTASK_BUDGET_MS;

    console.log(`\n  frame changed on scrub:   ${changed ? "yes" : "NO"}`);
    console.log(
      `  long tasks during scrub:  ${longtasks.length} (max ${maxLongTask.toFixed(1)} ms)`,
    );
    console.log(`  main stayed responsive:   ${mainResponsive ? "yes" : "NO"}`);
    if (errors.length > 0) console.error(`  page errors: ${errors.join(" | ")}`);

    if (!changed || !mainResponsive || errors.length > 0) {
      console.error("\n✖ streaming did not behave as expected.");
      exitCode = 1;
    } else {
      console.log(
        "\n✓ scrubbing streams new steps to the GPU with the main thread off the hot path.",
      );
    }
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
