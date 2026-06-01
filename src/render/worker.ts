import { getDevice, installGpu } from "@gpu";
import type { Camera, Object3D } from "three";
import type { RenderWorkerRequest, RenderWorkerResponse, SliceFieldPayload } from "./messages.ts";
import { createRaymarchScene, type RaymarchScene } from "./raymarchScene.ts";
import { type InstalledRenderer, installRenderer } from "./renderer.ts";
import { createTestScene, type TestScene } from "./scene.ts";
import { createSliceScene, type SliceScene } from "./sliceScene.ts";
import type { ScalarField } from "./volumeTexture.ts";

// Worker-scope view of `self`. The DOM lib types `self` as Window (whose
// postMessage wants a targetOrigin), so narrow it to the dedicated-worker surface.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<RenderWorkerRequest>) => void) | null;
  postMessage(message: RenderWorkerResponse, transfer?: Transferable[]): void;
};

let gpu: { dispose: () => void } | undefined;
let renderer: InstalledRenderer | undefined;
let testScene: TestScene | undefined; // boot frame (also the parity-test target)
let slice: SliceScene | undefined; // active data-driven slice, once a field arrives
let volume: RaymarchScene | undefined; // active raymarched volume, once one is shown
let dims = { width: 0, height: 0 };
// The init promise; renderFrame/showSlice await it so they can't race a half-built renderer
// even if a future caller stops gating on the `ready` response.
let initDone: Promise<void> | undefined;

async function init(request: Extract<RenderWorkerRequest, { kind: "init" }>): Promise<void> {
  gpu = await installGpu();
  renderer = await installRenderer({
    canvas: request.canvas,
    width: request.width,
    height: request.height,
    device: getDevice(),
  });
  testScene = createTestScene();
  dims = { width: request.width, height: request.height };
  renderer.renderOnce(testScene.scene, testScene.camera);
  ctx.postMessage({ kind: "ready", requestId: request.requestId });
}

// The most recently shown data scene (volume, then slice), else the boot triangle.
function currentScene(): { scene: Object3D; camera: Camera } {
  if (volume !== undefined) return { scene: volume.scene, camera: volume.camera };
  if (slice !== undefined) return { scene: slice.scene, camera: slice.camera };
  if (testScene !== undefined) return { scene: testScene.scene, camera: testScene.camera };
  throw new Error("no scene to render");
}

async function renderFrame(
  request: Extract<RenderWorkerRequest, { kind: "renderFrame" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("renderFrame before init");
  }
  const { scene, camera } = currentScene();
  const pixels = await renderer.readPixels(scene, camera);
  // Freshly allocated readback buffer (never shared) — safe to transfer.
  const buffer = pixels.buffer as ArrayBuffer;
  ctx.postMessage(
    {
      kind: "frame",
      requestId: request.requestId,
      width: dims.width,
      height: dims.height,
      pixels: buffer,
    },
    [buffer],
  );
}

function decodeSliceField(payload: SliceFieldPayload): ScalarField {
  const data =
    payload.dtype === "f64" ? new Float64Array(payload.buffer) : new Float32Array(payload.buffer);
  return { data, shape: payload.shape };
}

async function showSlice(
  request: Extract<RenderWorkerRequest, { kind: "showSlice" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("showSlice before init");
  }
  // Release the prior slice's Data3DTexture before building the next — else each swap leaks one.
  slice?.dispose();
  slice = createSliceScene({
    field: decodeSliceField(request.field),
    colormap: request.colormap,
    axis: request.axis,
    position: request.position,
  });
  renderer.renderOnce(slice.scene, slice.camera);
}

async function showVolume(
  request: Extract<RenderWorkerRequest, { kind: "showVolume" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("showVolume before init");
  }
  // Release the prior volume's Data3DTexture before building the next — else each swap leaks one.
  volume?.dispose();
  volume = createRaymarchScene({
    field: decodeSliceField(request.field),
    colormap: request.colormap,
    // exactOptionalPropertyTypes: only forward when set, so the scene's defaults apply.
    ...(request.steps !== undefined ? { steps: request.steps } : {}),
    ...(request.density !== undefined ? { density: request.density } : {}),
  });
  renderer.renderOnce(volume.scene, volume.camera);
}

function handle(request: RenderWorkerRequest): Promise<void> {
  switch (request.kind) {
    case "init":
      initDone = init(request);
      return initDone;
    case "renderFrame":
      return renderFrame(request);
    case "showSlice":
      return showSlice(request);
    case "showVolume":
      return showVolume(request);
    default: {
      const unreachable: never = request;
      return Promise.reject(new Error(`unknown request: ${JSON.stringify(unreachable)}`));
    }
  }
}

ctx.onmessage = (event) => {
  const request = event.data;
  handle(request).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.postMessage({ kind: "error", requestId: request.requestId, message });
  });
};

export function dispose(): void {
  volume?.dispose();
  slice?.dispose();
  testScene?.dispose();
  renderer?.dispose();
  gpu?.dispose();
}
