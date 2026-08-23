import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

// Regenerates the README hero from the real production build: the synthetic flux rope, |B| volume
// raymarching under a traced field-line rake. Headed Chrome — WebGPU on macOS/Metal is unreliable
// headless. `npx tsx scripts/shot-readme.ts [outPath]`; override the view with WEBPIC_POSE.

const OUT = process.argv[2] ?? "docs/assets/webpic-hero.png";
const SIZE = 128; // volume resolution: crisp enough for a still, well under the 256³ ceiling
const WINDOW = { width: 1600, height: 900 };
// "az,el,dist,tx,ty,tz,roll" (radians) — low elevation off the x axis, so the rake's traces cross
// on screen and the rope reads as twisted rather than as a bundle of parallel lines.
const POSE = process.env.WEBPIC_POSE ?? "0.4000,0.3000,2.1000,0,0,0,0";
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

    await page.goto(`${url}?n=${SIZE}&fieldlines&pose=${POSE}`, { waitUntil: "load" });
    await page.waitForFunction(
      () => performance.getEntriesByName("webpic:first-frame").length > 0,
      undefined,
      { timeout: 60_000 },
    );
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
