import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

// Regenerates the README hero from the real production build: the Earth dipole, |B| volume raymarching
// under a traced field-line rake that closes on the inner cutoff. Headed Chrome — WebGPU on
// macOS/Metal is unreliable headless. `npx tsx scripts/shot-readme.ts [outPath]`; override the view
// with WEBPIC_POSE.
//
// The dipole is a dropdown away rather than a URL parameter, so this drives the top bar's dataset
// picker — one click for a reader who wants the same frame. Everything else is the app's own default:
// the catalog's log scale over |B|, which spans four decades between the inner cutoff and the box edge.

const OUT = process.argv[2] ?? "docs/assets/webpic-hero.png";
const WINDOW = { width: 1600, height: 900 };
// "az,el,dist,tx,ty,tz,roll" (radians) — off the meridian the seed rake lies in, so the closed loops
// read as loops in perspective rather than as a flat fan, with the near-planet field filling frame.
const POSE = process.env.WEBPIC_POSE ?? "1.0000,0.3000,2.0000,0,0,0,0";
const SETTLE_MS = 3000; // trace + volume upload, then the camera settle ramp back to full render scale

async function main(): Promise<void> {
  await build({ logLevel: "warn" });
  const server = await preview({ preview: { port: 0 } });
  const url = server.resolvedUrls?.local?.[0];
  if (url === undefined) throw new Error("vite preview did not resolve a local URL");

  const profileDir = await mkdtemp(join(tmpdir(), "webpic-shot-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    deviceScaleFactor: 2, // retina-density PNG, so the README image stays crisp when scaled down
    viewport: WINDOW,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${WINDOW.width},${WINDOW.height + 120}`,
    ],
  });

  try {
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", e.message));

    await page.goto(`${url}?fieldlines&pose=${POSE}`, { waitUntil: "load" });
    await page.waitForFunction(
      () => performance.getEntriesByName("webpic:first-frame").length > 0,
      undefined,
      { timeout: 60_000 },
    );
    // Switch to the dipole (no URL parameter for it — the top bar's dataset picker is the way in).
    await page.click('button[data-control="dataset"]');
    await page.click('.webpic-popover_item[data-value="dipole"]');
    await page.waitForTimeout(SETTLE_MS); // re-read + recompute + retrace against the new grid

    // The probe marker defaults on and lands dead centre of the frame — off for the still.
    const probe = page.locator('[aria-label="Hide point marker"]');
    if ((await probe.count()) > 0) await probe.first().click();

    await page.mouse.move(WINDOW.width - 4, WINDOW.height - 4); // park the pointer clear of hovers
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: OUT });
    console.log(`wrote ${OUT}`);
  } finally {
    await context.close();
    await server.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

await main();
