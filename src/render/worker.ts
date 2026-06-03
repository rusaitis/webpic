import { getDevice, installGpu } from "@gpu";
import type { Camera, Object3D, OrthographicCamera, PerspectiveCamera } from "three";
import {
  applyPose,
  createOrthographicCamera,
  createPerspectiveCamera,
  DEFAULT_POSE,
} from "./camera.ts";
import type {
  CameraPose,
  RenderWorkerRequest,
  RenderWorkerResponse,
  SliceFieldPayload,
} from "./messages.ts";
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
// The worker owns the cameras (lifted out of the scene factories): the perspective camera is
// pose-driven for the volume; the orthographic one is screen-aligned for the slice + boot triangle.
let perspCamera: PerspectiveCamera | undefined;
let orthoCamera: OrthographicCamera | undefined;
let pose: CameraPose = DEFAULT_POSE;
let dims = { width: 0, height: 0 };
// The init promise; renderFrame/showSlice await it so they can't race a half-built renderer
// even if a future caller stops gating on the `ready` response.
let initDone: Promise<void> | undefined;

// Display-loop state. The loop runs in browser workers (requestAnimationFrame present); in Node it
// stays dormant and requestRender() paints synchronously, preserving the old one-shot behavior.
let needsRender = false; // on-demand: the loop paints only when something changed
let rafId: number | undefined; // undefined ⇒ no loop running
let readbackInFlight = false; // pauses the loop across a deterministic readPixels (see renderFrame)

function aspect(): number {
  return dims.height > 0 ? dims.width / dims.height : 1;
}

async function init(request: Extract<RenderWorkerRequest, { kind: "init" }>): Promise<void> {
  gpu = await installGpu();
  renderer = await installRenderer({
    canvas: request.canvas,
    width: request.width,
    height: request.height,
    device: getDevice(),
  });
  dims = { width: request.width, height: request.height };
  perspCamera = createPerspectiveCamera(aspect());
  orthoCamera = createOrthographicCamera();
  applyPose(perspCamera, pose, aspect());
  testScene = createTestScene();
  // Paint the boot triangle synchronously (the loop isn't started yet) so "first frame" honestly
  // means a frame is on the swapchain before `ready` fires — the perf-gate contract.
  requestRender();
  ctx.postMessage({ kind: "ready", requestId: request.requestId });
  startRenderLoop();
}

// The most recently shown data scene (volume, then slice), else the boot triangle — paired with the
// camera its projection needs: perspective for the volume, orthographic for the slice/boot frame.
function currentScene(): { scene: Object3D; camera: Camera } {
  if (perspCamera === undefined || orthoCamera === undefined) {
    throw new Error("render before init");
  }
  if (volume !== undefined) return { scene: volume.scene, camera: perspCamera };
  if (slice !== undefined) return { scene: slice.scene, camera: orthoCamera };
  if (testScene !== undefined) return { scene: testScene.scene, camera: orthoCamera };
  throw new Error("no scene to render");
}

// The single repaint entry point for message handlers. Sets the dirty flag for the loop; if no loop
// is running (Node, or the init boot paint before startRenderLoop), renders synchronously instead.
function requestRender(): void {
  needsRender = true;
  if (rafId === undefined && renderer !== undefined) {
    const { scene, camera } = currentScene();
    renderer.renderOnce(scene, camera);
    needsRender = false;
  }
}

function renderTick(): void {
  // Reschedule first so a throwing frame can't permanently strand the loop.
  rafId = requestAnimationFrame(renderTick);
  // M2.8 adds a `continuous` override here to force every-frame repaints for sustained
  // timestamp-query measurement; today the loop is purely on-demand.
  if (!needsRender || readbackInFlight || renderer === undefined) return;
  needsRender = false;
  const { scene, camera } = currentScene();
  renderer.renderOnce(scene, camera);
}

function startRenderLoop(): void {
  if (rafId !== undefined) return; // idempotent
  if (typeof requestAnimationFrame !== "function") return; // Node: requestRender paints synchronously
  rafId = requestAnimationFrame(renderTick);
}

async function renderFrame(
  request: Extract<RenderWorkerRequest, { kind: "renderFrame" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("renderFrame before init");
  }
  const { scene, camera } = currentScene();
  // Deterministic readback renders to an offscreen target, then awaits the GPU. The only async gap
  // in the worker's single thread is that await — block the display loop's swapchain render across
  // it, else a rAF frame between the readback render and its await would corrupt the read pixels.
  readbackInFlight = true;
  try {
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
  } finally {
    readbackInFlight = false;
    needsRender = true; // repaint the swapchain the readback borrowed the renderer from
  }
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
    // exactOptionalPropertyTypes: only forward when set, so the scene's full-range default applies.
    ...(request.windowLevel !== undefined ? { windowLevel: request.windowLevel } : {}),
  });
  requestRender();
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
    ...(request.windowLevel !== undefined ? { windowLevel: request.windowLevel } : {}),
    ...(request.steps !== undefined ? { steps: request.steps } : {}),
    ...(request.density !== undefined ? { density: request.density } : {}),
  });
  requestRender();
}

// Live window/level: retune the active scenes' uniforms and repaint, no scene rebuild.
async function setWindowLevel(
  request: Extract<RenderWorkerRequest, { kind: "setWindowLevel" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("setWindowLevel before init");
  }
  const { center, width } = request.windowLevel;
  slice?.setWindowLevel(center, width);
  volume?.setWindowLevel(center, width);
  requestRender();
}

// Live camera pose: re-aim the perspective camera and repaint. Only the volume is pose-driven, so a
// pose change while a screen-aligned slice/boot view is showing is a no-op repaint we skip.
async function setCameraPose(
  request: Extract<RenderWorkerRequest, { kind: "setCameraPose" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined || perspCamera === undefined) {
    throw new Error("setCameraPose before init");
  }
  pose = request.pose;
  applyPose(perspCamera, pose, aspect());
  if (volume !== undefined) requestRender();
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
    case "setWindowLevel":
      return setWindowLevel(request);
    case "setCameraPose":
      return setCameraPose(request);
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
  if (rafId !== undefined && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(rafId);
    rafId = undefined;
  }
  volume?.dispose();
  slice?.dispose();
  testScene?.dispose();
  renderer?.dispose();
  gpu?.dispose();
}
