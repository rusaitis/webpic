// The dispose round trip: every RenderModule, the renderer, and the GPU handle release, the stream
// port closes, and `disposed` acks — the teardown that a bare terminate() would leave unexercised.
// Mocks come from tests/renderWorkerHarness.ts (three/webgpu can't load in node).

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { RenderWorkerRequest } from "./messages.ts";

const h = await vi.hoisted(() =>
  import("../../tests/renderWorkerHarness.ts").then((m) => m.createWorkerHarness()),
);

vi.mock("@gpu", () => h.gpu);
vi.mock("./runtime/renderer.ts", () => ({ installRenderer: h.installRenderer }));
vi.mock("./volume/raymarchScene.ts", () => ({ createRaymarchScene: h.createRaymarchScene }));
vi.mock("./volume/sliceScene.ts", () => ({ createSliceScene: h.createSliceScene }));
vi.mock("./scene.ts", () => ({ createTestScene: h.createTestScene }));

const postMessage = vi.fn();
let onmessage: (event: { data: RenderWorkerRequest }) => void;

beforeAll(async () => {
  (globalThis as unknown as { self: unknown }).self = { postMessage };
  await import("./worker.ts");
  onmessage = (globalThis as unknown as { self: { onmessage: typeof onmessage } }).self.onmessage;
});

afterAll(() => {
  delete (globalThis as unknown as { self?: unknown }).self;
});

it("releases the scenes, renderer, gpu and stream port, then acks `disposed`", async () => {
  onmessage({
    data: {
      kind: "init",
      requestId: 1,
      canvas: {} as unknown as OffscreenCanvas,
      width: 8,
      height: 8,
      devicePixelRatio: 1,
    },
  });
  await vi.waitFor(() => expect(h.installRenderer).toHaveBeenCalledTimes(1));
  onmessage({
    data: {
      kind: "upsertLayer",
      requestId: 8,
      id: "layer-0",
      params: { layerKind: "volume" },
      field: { buffer: new Float32Array([5]).buffer, dtype: "f32", shape: [1, 1, 1] },
      colormap: "inferno",
      scale: "linear",
      opacity: 1,
    },
  });
  await vi.waitFor(() => expect(h.createRaymarchScene).toHaveBeenCalledTimes(1));
  const port = { close: vi.fn(), onmessage: null };
  onmessage({ data: { kind: "pair", requestId: 6, port: port as unknown as MessagePort } });

  onmessage({ data: { kind: "dispose", requestId: 16 } });
  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith({ kind: "disposed", requestId: 16 }),
  );

  const scene = h.createRaymarchScene.mock.results[0]?.value;
  expect(scene?.dispose).toHaveBeenCalledTimes(1);
  expect(h.renderers[0]?.dispose).toHaveBeenCalledTimes(1);
  expect(port.close).toHaveBeenCalledTimes(1);
  const gpu = await h.gpu.installGpu.mock.results[0]?.value;
  expect(gpu?.dispose).toHaveBeenCalledTimes(1);
});
