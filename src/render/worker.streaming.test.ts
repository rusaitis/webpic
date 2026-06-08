// Render-side streaming (M2.10a): the data worker pairs a MessagePort into the render worker and
// posts streamStep messages over it; the worker must route them through swapLayerField — rebuilding
// the existing layer's scene from the streamed field while keeping its retained look. three/webgpu
// can't load in node, so the renderer + scene factories + the gpu seam are mocked (same pattern as
// worker.recovery.test.ts). Flow: init → upsert layer-0 → pair port → streamStep over the port.

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
    dispose: vi.fn(),
  });
  return {
    makeScene,
    installRenderer: vi.fn(async () => ({
      renderer: {},
      renderComposite: vi.fn(),
      readCompositePixels: vi.fn(),
      setSize: vi.fn(),
      dispose: vi.fn(),
    })),
    createRaymarchScene: vi.fn((_opts: unknown) => makeScene()),
    createSliceScene: vi.fn((_opts: unknown) => makeScene()),
    createTestScene: vi.fn(() => ({ scene: {}, dispose: vi.fn() })),
  };
});

vi.mock("@gpu", () => ({
  installGpu: vi.fn(async () => ({ dispose: vi.fn() })),
  getDevice: vi.fn(() => ({ queue: { onSubmittedWorkDone: async () => undefined } })),
  getCapabilities: vi.fn(() => ({ hasTimestampQuery: false, hasFloat32Filterable: false })),
  onDeviceLost: () => () => {},
  onDeviceRestored: () => () => {},
}));
vi.mock("./renderer.ts", () => ({ installRenderer: h.installRenderer }));
vi.mock("./raymarchScene.ts", () => ({ createRaymarchScene: h.createRaymarchScene }));
vi.mock("./sliceScene.ts", () => ({ createSliceScene: h.createSliceScene }));
vi.mock("./scene.ts", () => ({ createTestScene: h.createTestScene }));

let onmessage: (event: { data: RenderWorkerRequest }) => void;

beforeAll(async () => {
  (globalThis as unknown as { self: unknown }).self = { postMessage: vi.fn() };
  await import("./worker.ts");
  onmessage = (globalThis as unknown as { self: { onmessage: typeof onmessage } }).self.onmessage;
});

afterAll(() => {
  delete (globalThis as unknown as { self?: unknown }).self;
});

it("routes a streamStep over the paired port through swapLayerField (rebuilds with the new field)", async () => {
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

  // The data worker's initial upsert creates the volume layer (scene #1, field shape [1,1,1]).
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

  // Pair the streaming port, then stream a new step's scalar over it (distinct shape [2,2,2]).
  const channel = new MessageChannel();
  onmessage({ data: { kind: "pair", requestId: 3, port: channel.port2 } });
  const buffer = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  channel.port1.postMessage(
    {
      kind: "streamStep",
      id: "layer-0",
      step: 3,
      field: { buffer, dtype: "f32", shape: [2, 2, 2] },
    },
    [buffer],
  );

  // The streamed field rebuilds the layer's scene (#2) — keeping its retained colormap/scale.
  await vi.waitFor(() => expect(h.createRaymarchScene).toHaveBeenCalledTimes(2));
  expect(h.createRaymarchScene.mock.calls[1]?.[0]).toMatchObject({
    colormap: "inferno",
    field: { shape: [2, 2, 2] },
  });
  channel.port1.close();
});

it("ignores a streamStep for an unknown layer (heals on the next upsert)", async () => {
  const before = h.createRaymarchScene.mock.calls.length;
  const channel = new MessageChannel();
  onmessage({ data: { kind: "pair", requestId: 4, port: channel.port2 } });
  const buffer = new Float32Array([9]).buffer;
  channel.port1.postMessage(
    {
      kind: "streamStep",
      id: "missing",
      step: 1,
      field: { buffer, dtype: "f32", shape: [1, 1, 1] },
    },
    [buffer],
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(h.createRaymarchScene).toHaveBeenCalledTimes(before); // no rebuild for a missing layer
  channel.port1.close();
});
