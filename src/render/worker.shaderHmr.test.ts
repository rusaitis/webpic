// Dev shader hot-reload, worker side: a `rebuildShader` request re-imports the raymarch scene
// factory fresh (mocked here via shaderReload.ts) and swaps every volume layer's material in place
// through the registry — no scene rebuild, no field re-transfer — then re-warms the composite and
// repaints. three/webgpu can't load in node, so the renderer + scene factories + the gpu seam + the
// reload helper are mocked (same pattern as worker.streaming.test.ts). Flow: init → upsert volume →
// rebuildShader.

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { RenderWorkerRequest } from "./messages.ts";

const h = vi.hoisted(() => {
  const makeScene = () => ({
    scene: {},
    setWindowLevel: vi.fn(),
    setColormap: vi.fn(),
    setScale: vi.fn(),
    setShading: vi.fn(),
    setOpacity: vi.fn(),
    setStepScale: vi.fn(),
    setProjection: vi.fn(),
    setField: vi.fn(() => true),
    rebuildShader: vi.fn(),
    dispose: vi.fn(),
  });
  // The fresh material builder the re-import hands back; loadFreshRaymarchBuilder resolves to it.
  const freshBuilder = vi.fn(() => ({}));
  return {
    makeScene,
    freshBuilder,
    installRenderer: vi.fn(async () => ({
      renderer: {},
      renderComposite: vi.fn(),
      compileComposite: vi.fn(async () => {}),
      readCompositePixels: vi.fn(),
      setSize: vi.fn(),
      setRenderScale: vi.fn(),
      dispose: vi.fn(),
    })),
    createRaymarchScene: vi.fn((_opts: unknown) => makeScene()),
    createSliceScene: vi.fn((_opts: unknown) => makeScene()),
    createTestScene: vi.fn(() => ({ scene: {}, dispose: vi.fn() })),
    loadFreshRaymarchBuilder: vi.fn(async (_timestamp: number) => freshBuilder),
  };
});

vi.mock("@gpu", () => ({
  installGpu: vi.fn(async () => ({ dispose: vi.fn() })),
  getDevice: vi.fn(() => ({ queue: { onSubmittedWorkDone: async () => undefined } })),
  getCapabilities: vi.fn(() => ({ hasTimestampQuery: false, hasFloat32Filterable: false })),
  onDeviceLost: () => () => {},
  onDeviceRestored: () => () => {},
}));
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
      layerKind: "volume",
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
  onmessage({ data: { kind: "rebuildShader", requestId: 14, timestamp: 111 } });
  // Give the rejected dynamic import a tick to settle; the handler swallows it (reportFault).
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(scene.rebuildShader.mock.calls.length).toBe(callsBefore); // no swap on a bad edit
});
