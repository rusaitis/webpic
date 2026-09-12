// Dev shader hot-reload, worker side: a `rebuildShader` request re-imports the raymarch scene
// factory fresh (mocked here via shaderReload.ts) and swaps every volume layer's material in place
// through the registry — no scene rebuild, no field re-transfer — then re-warms the composite and
// repaints. Mocks come from tests/renderWorkerHarness.ts plus the reload helper. Flow: init → upsert
// volume → rebuildShader.

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { RenderWorkerRequest } from "./messages.ts";

const h = await vi.hoisted(async () => {
  const { createWorkerHarness } = await import("../../tests/renderWorkerHarness.ts");
  // The fresh material builder the re-import hands back; loadFreshRaymarchBuilder resolves to it.
  const freshBuilder = vi.fn(() => ({}));
  return {
    ...createWorkerHarness(),
    freshBuilder,
    loadFreshRaymarchBuilder: vi.fn(async (_timestamp: number) => freshBuilder),
  };
});

vi.mock("@gpu", () => h.gpu);
vi.mock("./runtime/renderer.ts", () => ({ installRenderer: h.installRenderer }));
vi.mock("./volume/raymarchScene.ts", () => ({ createRaymarchScene: h.createRaymarchScene }));
vi.mock("./volume/sliceScene.ts", () => ({ createSliceScene: h.createSliceScene }));
vi.mock("./scene.ts", () => ({ createTestScene: h.createTestScene }));
vi.mock("./volume/shaderReload.ts", () => ({
  loadFreshRaymarchBuilder: h.loadFreshRaymarchBuilder,
}));

let onmessage: (event: { data: RenderWorkerRequest }) => void;

beforeAll(async () => {
  (globalThis as unknown as { self: unknown }).self = { postMessage: vi.fn() };
  await import("./worker.ts");
  onmessage = (globalThis as unknown as { self: { onmessage: typeof onmessage } }).self.onmessage;
});

afterAll(() => {
  delete (globalThis as unknown as { self?: unknown }).self;
});

it("rebuildShader re-imports fresh code and swaps the volume material in place (no rebuild)", async () => {
  onmessage({
    data: {
      kind: "init",
      requestId: 1,
      canvas: {} as unknown as OffscreenCanvas,
      width: 64,
      height: 64,
      devicePixelRatio: 1,
    },
  });
  await vi.waitFor(() => expect(h.installRenderer).toHaveBeenCalledTimes(1));

  onmessage({
    data: {
      kind: "upsertLayer",
      requestId: 2,
      id: "layer-0",
      params: { layerKind: "volume" },
      field: { buffer: new Float32Array([5]).buffer, dtype: "f32", shape: [1, 1, 1] },
      colormap: "inferno",
      scale: "linear",
      opacity: 1,
    },
  });
  await vi.waitFor(() => expect(h.createRaymarchScene).toHaveBeenCalledTimes(1));
  const scene = h.createRaymarchScene.mock.results[0]?.value as {
    rebuildShader: ReturnType<typeof vi.fn>;
  };
  const renderer = (await h.installRenderer.mock.results[0]?.value) as {
    compileComposite: ReturnType<typeof vi.fn>;
  };
  const warmsBefore = renderer.compileComposite.mock.calls.length; // the upsert already warmed once

  // Edit fired on the main HMR client → rebuildShader with Vite's update timestamp.
  onmessage({ data: { kind: "rebuildShader", requestId: 14, timestamp: 987654321 } });

  // Re-imports fresh code (cache-busted by the timestamp), swaps the material with the fresh builder,
  // and re-warms the composite — never rebuilds the scene (no extra createRaymarchScene).
  await vi.waitFor(() => expect(scene.rebuildShader).toHaveBeenCalledTimes(1));
  expect(h.loadFreshRaymarchBuilder).toHaveBeenCalledWith(987654321);
  expect(scene.rebuildShader).toHaveBeenCalledWith(h.freshBuilder);
  expect(h.createRaymarchScene).toHaveBeenCalledTimes(1); // material swap, not a scene rebuild
  expect(renderer.compileComposite.mock.calls.length).toBe(warmsBefore + 1); // re-warmed
});

it("ignores a rebuildShader when the fresh import fails (keeps the prior shader)", async () => {
  h.loadFreshRaymarchBuilder.mockRejectedValueOnce(new Error("WGSL parse error mid-edit"));
  const scene = h.createRaymarchScene.mock.results.at(-1)?.value as {
    rebuildShader: ReturnType<typeof vi.fn>;
  };
  const callsBefore = scene.rebuildShader.mock.calls.length;
  const self = (globalThis as unknown as { self: { postMessage: ReturnType<typeof vi.fn> } }).self;
  onmessage({ data: { kind: "rebuildShader", requestId: 14, timestamp: 111 } });
  // The handler swallows the bad edit into a posted fault (reportFault) — wait for that, not a timer.
  await vi.waitFor(() =>
    expect(self.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error", message: "WGSL parse error mid-edit" }),
    ),
  );
  expect(scene.rebuildShader.mock.calls.length).toBe(callsBefore); // no swap on a bad edit
});
