import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstrument } from "./harness/browserSession.ts";
import { collectPageErrors, waitForFirstFrame } from "./harness/pageProbes.ts";

// Manual verification instrument for the z-up scene + magviz-feel camera: drives real Chrome stable
// (WebGPU/Metal needs a head, same as verify-streaming-render.ts), boots the default scene
// (volume + axes overlay ⇒ the ≥2-layer present path), and captures screenshots a reviewer judges:
// the boot frame must be the bare background (no RGB test triangle), the blue +z axis must point UP
// and agree with the CSS gnomon. Also drives the full pointer surface — orbit drag with damped
// glide, cursor-anchored wheel, right-drag pan, double-click reset tween, gnomon tip snap — and
// reads the pose off the bottom rail's coords card after each gesture.
// Run: `node scripts/verify-orientation.ts`.

const WINDOW = "1280,860";

async function main(): Promise<void> {
  // The shots are the deliverable — left in place for the reviewer, path printed below.
  const shotDir = await mkdtemp(join(tmpdir(), "webpic-orientation-"));
  await runInstrument(
    async ({ page, baseUrl }) => {
      const errors = collectPageErrors(page, /Failed to load resource/i);

      await page.goto(baseUrl, { waitUntil: "load" });
      await waitForFirstFrame(page, 30_000);
      // Boot frame, captured immediately: must be the bare background — the RGB triangle flash is
      // gone (it now needs ?debugScene). The volume may or may not have landed yet; either is fine,
      // a colored triangle is not.
      await page.screenshot({ path: join(shotDir, "0-boot.png") });
      await page.waitForTimeout(600); // volume warm-compile + commit + a few settled frames
      // The probe marker defaults on and sits at the box center, where every gesture below is anchored —
      // leave it up and the drags grab the marker instead of the camera. Off for the whole run.
      const probe = page.locator('[data-control="probe"]');
      await probe.waitFor({ state: "attached" }); // missing hook is a broken probe, not "already off"
      if ((await probe.getAttribute("aria-pressed")) === "true") await probe.click();
      // The pose lives in the C-toggled coords card's View + Center rows (ui/camera/bottomRail) — the two rows
      // parented directly by the card, next to the nested grid rows. Every canvas gesture below is an
      // outside pointer-down, which dismisses the card, so re-open it before each read.
      const card = page.locator(".webpic-coords-card");
      const poseRows = page.locator(".webpic-coords-card > .webpic-coords-card_row");
      const readout = async (): Promise<string> => {
        if (await card.isHidden()) await page.keyboard.press("c");
        await card.waitFor({ state: "visible", timeout: 5_000 });
        const rows = await poseRows.allInnerTexts();
        return rows.join("  ·  ").replace(/\s+/g, " ");
      };

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

      // Double-click: pick-to-focus — an eased fly onto the picked point, so the center moves onto the
      // volume and the distance closes to the echoed focus distance (it is not a reset-to-default).
      await page.mouse.dblclick(cx, cy);
      await page.waitForTimeout(700); // 400 ms tween + margin
      const afterFocusPose = await readout();
      await page.screenshot({ path: join(shotDir, "5-after-dblclick-focus.png") });

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
      console.log(`after focus: ${afterFocusPose}`);
      console.log(`after snap:  ${afterSnapPose}`);
      if (errors.length === 0) return 0;
      console.error(`page errors (${errors.length}):`);
      for (const e of errors) console.error(`  ${e}`);
      return 1;
    },
    { chromeArgs: [`--window-size=${WINDOW}`] },
  );
}

void main();
