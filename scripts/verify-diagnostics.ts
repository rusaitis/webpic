import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

// One-off M2.8 verification (not a CI gate): drives real Chrome stable, ticks the diagnostics
// "Measure (continuous)" toggle, and confirms a finite per-frame GPU time streams back with the
// timestamp-query clock label — the one integration the node/dom tests can't exercise (three's
// resolveTimestampsAsync against a live device). Run: `npx tsx scripts/verify-diagnostics.ts`.

async function main(): Promise<void> {
  await build({ logLevel: "warn" });
  const server = await preview({ preview: { port: 0 } });
  const url = server.resolvedUrls?.local?.[0];
  if (url === undefined) throw new Error("vite preview did not resolve a local URL");

  const profileDir = await mkdtemp(join(tmpdir(), "webpic-diag-"));
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
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(
      () => performance.getEntriesByName("webpic:first-frame").length > 0,
      undefined,
      { timeout: 15_000 },
    );

    // The Developer window is closed on boot (it is a dev instrument, not chrome), so open it from
    // the rail before locating its Diagnostics pane.
    await page.locator('.webpic-siderail [data-control="diagnostics"]').click();

    // The diagnostics readout before measuring — should be awaiting a frame (continuous off).
    const before = await page
      .getByLabel("Developer", { exact: true })
      .locator(".webpic-pane", { hasText: "Diagnostics" })
      .innerText();

    // Tick "Measure (continuous)" to force the sustained-timing loop, then read the streaming value.
    // force: the styled SVG box overlays the real <input>, intercepting a normal click — but
    // checking the input directly still fires its change handler (which drives the store intent).
    await page
      .locator(".webpic-pane", { hasText: "Diagnostics" })
      .locator(".webpic-checkbox_input")
      .check({ force: true });

    // Wait until the readout shows a real "<n>.<nn> ms ... gate ..." line.
    const readout = page
      .locator(".webpic-pane", { hasText: "Diagnostics" })
      .locator(".webpic-placeholder");
    await page.waitForFunction(
      // The Node tsconfig lacks DOM globals; read textContent off a minimal typed view.
      (el) => /\d+\.\d{2} ms/.test((el as { textContent: string | null }).textContent ?? ""),
      await readout.elementHandle(),
      { timeout: 10_000 },
    );

    // Let the continuous loop run so the 30-frame rolling mean settles (a bad first sample, if any,
    // ages out), then read the stabilized value.
    await page.waitForTimeout(2000);
    const after = await readout.innerText();

    const match = after.match(/(-?\d+\.\d{2}) ms/);
    const meanMs = match ? Number(match[1]) : Number.NaN;
    const isTimestamp = after.includes("timestamp-query");
    const plausible = Number.isFinite(meanMs) && meanMs >= 0 && meanMs < 100; // sane per-frame GPU ms
    console.log(`\n  before:  ${before.replace(/\n/g, " · ")}`);
    console.log(`  after:   ${after}`);
    console.log(`\n  rolling mean = ${meanMs} ms`);
    console.log(`  clock = timestamp:     ${isTimestamp ? "yes" : "no (wall-clock fallback)"}`);
    console.log(`  plausible per-frame:   ${plausible ? "yes" : "NO"}`);
    if (errors.length > 0) console.error(`  page errors: ${errors.join(" | ")}`);

    if (!plausible) {
      console.error("\n✖ rolling GPU time is not a plausible per-frame value.");
      exitCode = 1;
    } else {
      console.log("\n✓ frameTiming flows end-to-end into the diagnostics panel with sane values.");
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
