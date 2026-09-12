// Shared fakes for the render-worker suites (worker.*.test.ts): three/webgpu can't load in node, so
// the renderer + scene factories + the gpu seam are mocked. Vitest hoists `vi.mock` per file, so each
// suite keeps its own one-liners and points them at one `createWorkerHarness()` instance. Test-only.

import { vi } from "vitest";

export interface DeviceLossEvent {
  readonly kind: string;
  readonly message: string;
  readonly terminal: boolean;
}

export type FakeScene = ReturnType<typeof makeFakeScene>;
export type FakeRenderer = ReturnType<typeof makeFakeRenderer>;

// setField accepts the in-place swap by default; a suite overrides it to force the rebuild fallback.
export function makeFakeScene() {
  return {
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
  };
}

export function makeFakeRenderer() {
  return {
    renderer: {},
    renderComposite: vi.fn(),
    compileComposite: vi.fn(async () => {}),
    readCompositePixels: vi.fn(),
    readPixels: vi.fn(),
    setSize: vi.fn(),
    setRenderScale: vi.fn(),
    dispose: vi.fn(),
  };
}

export function makeFakeDevice() {
  return { queue: { onSubmittedWorkDone: async () => undefined } };
}

export function createWorkerHarness() {
  const renderers: FakeRenderer[] = [];
  const lostCbs: Array<(event: DeviceLossEvent) => void> = [];
  const restoredCbs: Array<(device: unknown) => void> = [];
  const installRenderer = vi.fn(async (_opts: { device?: unknown }) => {
    const renderer = makeFakeRenderer();
    renderers.push(renderer);
    return renderer;
  });
  const gpu = {
    installGpu: vi.fn(async () => ({ dispose: vi.fn() })),
    getDevice: vi.fn(makeFakeDevice),
    getCapabilities: vi.fn(() => ({ hasTimestampQuery: false, hasFloat32Filterable: false })),
    onDeviceLost: (cb: (event: DeviceLossEvent) => void): (() => void) => {
      lostCbs.push(cb);
      return () => {};
    },
    onDeviceRestored: (cb: (device: unknown) => void): (() => void) => {
      restoredCbs.push(cb);
      return () => {};
    },
    resetLedger: vi.fn(),
    vramSnapshot: vi.fn(() => ({ totalBytes: 0, byKey: [] })),
  };
  return {
    gpu,
    renderers,
    lostCbs,
    restoredCbs,
    installRenderer,
    createRaymarchScene: vi.fn((_opts: unknown) => makeFakeScene()),
    createSliceScene: vi.fn((_opts: unknown) => makeFakeScene()),
    createTestScene: vi.fn(() => ({ scene: {}, dispose: vi.fn() })),
  };
}
