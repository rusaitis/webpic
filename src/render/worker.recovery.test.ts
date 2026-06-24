// Render-side device-loss recovery: when gpu/ re-acquires the device after a loss and fires
// onDeviceRestored, the worker must rebuild the renderer on the new device and rebuild every layer
// scene from its retained CPU source (no main↔worker reseed). three/webgpu can't load in node, so
// the renderer + scene factories + the gpu seam are mocked; camera.ts / frameTimer.ts / messages.ts
// are the real (pure-three / pure-JS) modules. One stateful flow: init → upsert → loss → restore.

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { RenderWorkerRequest } from "./messages.ts";

const h = vi.hoisted(() => {
  const lostCbs: Array<(e: { kind: string; message: string; terminal: boolean }) => void> = [];
  const restoredCbs: Array<(d: unknown) => void> = [];
  const renderers: Array<{
    renderComposite: ReturnType<typeof vi.fn>;
    compileComposite: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const makeScene = () => ({
    scene: {},
    setWindowLevel: vi.fn(),
    setColormap: vi.fn(),
    setScale: vi.fn(),
    setOpacity: vi.fn(),
    setStepScale: vi.fn(),
    setProjection: vi.fn(),
    dispose: vi.fn(),
  });
  return {
    lostCbs,
    restoredCbs,
    renderers,
    makeScene,
    installRenderer: vi.fn(async (_opts: { device?: unknown }) => {
      const r = {
        renderer: {},
        renderComposite: vi.fn(),
        compileComposite: vi.fn(async () => {}),
        readCompositePixels: vi.fn(),
        readPixels: vi.fn(),
        setSize: vi.fn(),
        setRenderScale: vi.fn(),
        dispose: vi.fn(),
      };
      h.renderers.push(r);
      return r;
    }),
    createRaymarchScene: vi.fn(() => h.makeScene()),
    createSliceScene: vi.fn(() => h.makeScene()),
    createTestScene: vi.fn(() => ({ scene: {}, dispose: vi.fn() })),
  };
});

vi.mock("@gpu", () => ({
  installGpu: vi.fn(async () => ({ dispose: vi.fn() })),
  getDevice: vi.fn(() => ({ queue: { onSubmittedWorkDone: async () => undefined } })),
  getCapabilities: vi.fn(() => ({ hasTimestampQuery: false, hasFloat32Filterable: false })),
  onDeviceLost: (cb: (e: { kind: string; message: string; terminal: boolean }) => void) => {
    h.lostCbs.push(cb);
    return () => {};
  },
  onDeviceRestored: (cb: (d: unknown) => void) => {
    h.restoredCbs.push(cb);
    return () => {};
  },
  resetLedger: vi.fn(),
  vramSnapshot: vi.fn(() => ({ totalBytes: 0, byKey: [] })),
}));
vi.mock("./runtime/renderer.ts", () => ({ installRenderer: h.installRenderer }));
vi.mock("./volume/raymarchScene.ts", () => ({ createRaymarchScene: h.createRaymarchScene }));
vi.mock("./volume/sliceScene.ts", () => ({ createSliceScene: h.createSliceScene }));
vi.mock("./scene.ts", () => ({ createTestScene: h.createTestScene }));

let onmessage: (event: { data: RenderWorkerRequest }) => void;

beforeAll(async () => {
  // worker.ts reads `self` at module eval — provide a dedicated-worker-ish surface first.
  (globalThis as unknown as { self: unknown }).self = { postMessage: vi.fn() };
  await import("./worker.ts");
  onmessage = (globalThis as unknown as { self: { onmessage: typeof onmessage } }).self.onmessage;
});

afterAll(() => {
  delete (globalThis as unknown as { self?: unknown }).self;
});

it("rebuilds the renderer + every layer scene on the new device when the device is restored", async () => {
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

  // Seed one volume layer (carries a real ArrayBuffer so decodeSliceField succeeds).
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

  // A recoverable loss (terminal:false), then restore on a fresh GPUDevice.
  expect(h.lostCbs.length).toBeGreaterThan(0);
  for (const cb of h.lostCbs) cb({ kind: "unknown", message: "reset", terminal: false });
  const newDevice = { queue: { onSubmittedWorkDone: async () => undefined } };
  for (const cb of h.restoredCbs) cb(newDevice);

  // The renderer is reinstalled on the new device and the layer scene is rebuilt from its source.
  await vi.waitFor(() => expect(h.installRenderer).toHaveBeenCalledTimes(2));
  expect(h.createRaymarchScene).toHaveBeenCalledTimes(2);
  expect(h.installRenderer.mock.calls[1]?.[0]).toMatchObject({ device: newDevice });

  // The post-restore repaint hits the *new* renderer, not the dead one — after its pipelines were
  // warmed (compileComposite precedes the un-pause, so the first restored frame doesn't stall).
  const restored = h.renderers[1];
  await vi.waitFor(() => expect(restored?.renderComposite).toHaveBeenCalled());
  expect(restored?.compileComposite).toHaveBeenCalled();
});

it("posts gpuRecoveryFailed and does not rebuild on a terminal loss", () => {
  const self = (globalThis as unknown as { self: { postMessage: ReturnType<typeof vi.fn> } }).self;
  self.postMessage.mockClear();
  const installsBefore = h.installRenderer.mock.calls.length;

  // A terminal loss (breaker tripped / no adapter) must not rebuild — it surfaces a reload state.
  for (const cb of h.lostCbs) cb({ kind: "unknown", message: "no GPUAdapter", terminal: true });

  expect(h.installRenderer.mock.calls.length).toBe(installsBefore);
  const failed = self.postMessage.mock.calls
    .map((call) => call[0] as { kind: string; reason?: string })
    .find((m) => m.kind === "gpuRecoveryFailed");
  expect(failed).toMatchObject({ kind: "gpuRecoveryFailed", reason: "no-adapter" });
});
