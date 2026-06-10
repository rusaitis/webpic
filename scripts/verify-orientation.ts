import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

// One-off verification for the z-up scene + magviz-feel camera: drives real Chrome stable
// (WebGPU/Metal needs a head, same as verify-streaming-render.ts), boots the default scene
// (volume + axes overlay ⇒ the ≥2-layer present path), and captures screenshots a reviewer judges:
// the boot frame must be the bare background (no RGB test triangle), the blue +z axis must point UP
// and agree with the CSS gnomon. Also drives the full pointer surface — orbit drag with damped
// glide, cursor-anchored wheel, right-drag pan, double-click reset tween, gnomon tip snap — and
// reads the pose HUD after each gesture. Run: `node scripts/verify-orientation.ts`.

const WINDOW = "1280,860";

async function main(): Promise<void> {
  await build({ logLevel: "warn" });
  const server = await preview({ preview: { port: 0 } });
  const url = server.resolvedUrls?.local?.[0];
  if (url === undefined) throw new Error("vite preview did not resolve a local URL");

  const shotDir = await mkdtemp(join(tmpdir(), "webpic-orientation-"));
  const profileDir = await mkdtemp(join(tmpdir(), "webpic-orientation-profile-"));
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
      if (msg.type() === "error" && !/Failed to load resource/i.test(msg.text())) {
        errors.push(msg.text());
      }
    });

    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(
      () => performance.getEntriesByName("webpic:first-frame").length > 0,
      undefined,
      { timeout: 30_000 },
    );
    // Boot frame, captured immediately: must be the bare background — the RGB triangle flash is
    // gone (it now needs ?debugScene). The volume may or may not have landed yet; either is fine,
    // a colored triangle is not.
    await page.screenshot({ path: join(shotDir, "0-boot.png") });
    await page.waitForTimeout(600); // volume warm-compile + commit + a few settled frames
    const readout = (): Promise<string> =>
      page.locator(".webpic-readout").innerText({ timeout: 5_000 });

    const initialPose = await readout();
    await page.screenshot({ path: join(shotDir, "1-initial.png") });

    const canvas = page.locator("canvas").first();
    const box = await canvas.boundingBox();
    if (box === null) throw new Error("canvas has no bounding box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Drag DOWN through the real pointer pipeline: elevation must RISE (camera over the top),
    // and the scene must visibly tip its front face down, gnomon agreeing.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(cx, cy + i * 12);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(150); // mid-glide
    const midGlidePose = await readout();
    await page.waitForTimeout(1200); // glide settles (τ ≈ 100 ms)
    const afterDragPose = await readout();
    await page.screenshot({ path: join(shotDir, "2-after-drag-down.png") });

    // Wheel zoom-in anchored off-center (right quarter): distance must shrink, target must move.
    await page.mouse.move(box.x + box.width * 0.75, cy);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(300);
    const afterZoomPose = await readout();
    await page.screenshot({ path: join(shotDir, "3-after-zoom-to-cursor.png") });

    // Right-drag pan: only the target may change (azimuth/elevation/distance hold).
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: "right" });
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(cx + i * 15, cy + i * 8);
      await page.waitForTimeout(16);
    }
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(800);
    const afterPanPose = await readout();
    await page.screenshot({ path: join(shotDir, "4-after-right-drag-pan.png") });

    // Double-click: eased fly back to the default pose (az 45°, el 27°, d 2.39, target 0).
    await page.mouse.dblclick(cx, cy);
    await page.waitForTimeout(700); // 400 ms tween + margin
    const afterResetPose = await readout();
    await page.screenshot({ path: join(shotDir, "5-after-dblclick-reset.png") });

    // Gnomon +x tip: snap to the side view (az 0°, el 0°), distance preserved.
    await page.locator(".webpic-gnomon_tip.is-px").click({ force: true });
    await page.waitForTimeout(700);
    const afterSnapPose = await readout();
    await page.screenshot({ path: join(shotDir, "6-after-gnomon-snap-px.png") });

    console.log(`shots:       ${shotDir}`);
    console.log(`initial:     ${initialPose}`);
    console.log(`mid-glide:   ${midGlidePose}`);
    console.log(`after drag:  ${afterDragPose}`);
    console.log(`after zoom:  ${afterZoomPose}`);
    console.log(`after pan:   ${afterPanPose}`);
    console.log(`after reset: ${afterResetPose}`);
    console.log(`after snap:  ${afterSnapPose}`);
    if (errors.length > 0) {
      exitCode = 1;
      console.error(`page errors (${errors.length}):`);
      for (const e of errors) console.error(`  ${e}`);
    }
  } finally {
    await context.close();
    await server.close();
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
