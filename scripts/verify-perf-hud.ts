import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build, preview } from "vite";

// One-off verification (not a CI gate) for the dev performance HUD: drives real Chrome stable against
// a ?perf preview build (the only place crossOriginIsolated is true, so measureUserAgentSpecificMemory
// works), toggles the HUD with Shift+P, orbits to produce painted frames, and confirms a perfSample
// round-trips — VRAM tracked, frame/CPU timing finite — with no page errors. This is the integration
// the node/dom tests can't exercise (dynamic-import chunk + worker round-trip + live device).
// Run: `npx tsx scripts/verify-perf-hud.ts`.

async function main(): Promise<void> {
  await build({ logLevel: "warn" });
  const server = await preview({ preview: { port: 0 } });
  const url = server.resolvedUrls?.local?.[0];
  if (url === undefined) throw new Error("vite preview did not resolve a local URL");

  const profileDir = await mkdtemp(join(tmpdir(), "webpic-perf-"));
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
    // ?perf force-enables the HUD in a production preview build (DEV is false there).
    await page.goto(`${url}?perf`, { waitUntil: "load" });
    await page.waitForFunction(
      () => performance.getEntriesByName("webpic:first-frame").length > 0,
      undefined,
      { timeout: 15_000 },
    );

    // Shift+P toggles the HUD; the chunk is dynamic-imported, so wait for it to mount + reveal.
    await page.keyboard.press("Shift+P");
    const hud = page.locator(".webpic-perf");
    await hud.waitFor({ state: "visible", timeout: 10_000 });

    // Orbit (A held) to produce painted frames so the worker streams perfSamples (the HUD never
    // forces frames itself). The settle ramp paints a few more after release.
    await page.keyboard.down("a");
    await page.waitForTimeout(900);
    await page.keyboard.up("a");
    await page.waitForTimeout(600);

    // Open the detail panel (worker topology + memory breakdown).
    await hud.locator(".webpic-perf_caret").click();
    await page.waitForTimeout(300);

    const text = await hud.innerText();
    const flat = text.replace(/\s+/g, " ").trim(); // innerText newlines between label/value
    // VRAM populated → the ledger saw the volume texture + render targets (our own accounting).
    const vramMatch = flat.match(/vram\s+([\d.]+)\s+(MB|GB)/i);
    const vramOk = vramMatch !== null && Number(vramMatch[1]) > 0;
    // Frame/CPU finite (a real painted-frame sample arrived), or honest idle.
    const hasFrame = /(frame ≈?|cpu)\s+[\d.]+\s*ms/i.test(flat);
    const hasFps = /\d+\s*fps|idle/i.test(flat);
    const hasWorkers = /render/i.test(flat) && /main/i.test(flat);

    const shot = join(tmpdir(), "webpic-perf-hud.png"); // outside profileDir so it survives cleanup
    await hud.screenshot({ path: shot }).catch(() => {});
    console.log(`\n  [flat] ${flat}\n  [shot] ${shot}\n`);
    console.log(
      `  vram tracked:        ${vramOk ? `yes (${vramMatch?.[1]} ${vramMatch?.[2]})` : "NO"}`,
    );
    console.log(`  frame/cpu timing:    ${hasFrame ? "yes" : "no (idle only)"}`);
    console.log(`  fps readout:         ${hasFps ? "yes" : "NO"}`);
    console.log(`  worker topology:     ${hasWorkers ? "yes (main + render)" : "NO"}`);
    if (errors.length > 0) console.error(`  page errors: ${errors.join(" | ")}`);

    if (!vramOk || !hasFps || !hasWorkers || errors.length > 0) {
      console.error("\n✖ perf HUD did not populate as expected.");
      exitCode = 1;
    } else {
      console.log(
        "\n✓ perf HUD mounts, samples round-trip from the worker, and the topology lists workers.",
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
