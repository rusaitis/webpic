import { getDevice, installGpu } from "@gpu";
import type { OrthographicCamera, PerspectiveCamera } from "three";
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
import { type CompositeItem, type InstalledRenderer, installRenderer } from "./renderer.ts";
import { createTestScene, type TestScene } from "./scene.ts";
import { createSliceScene, type SliceScene } from "./sliceScene.ts";
import type { ScalarField } from "./volumeTexture.ts";

// One renderable layer's scene + its kind (the kind picks the camera at composite time).
interface LayerEntry {
  readonly scene: SliceScene | RaymarchScene;
  readonly kind: "slice" | "volume";
}
// The ordered visibility/opacity view of the layer stack (draw order = array order).
interface CompositeEntry {
  readonly id: string;
  readonly visible: boolean;
  readonly opacity: number;
}

// Worker-scope view of `self`. The DOM lib types `self` as Window (whose
// postMessage wants a targetOrigin), so narrow it to the dedicated-worker surface.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<RenderWorkerRequest>) => void) | null;
  postMessage(message: RenderWorkerResponse, transfer?: Transferable[]): void;
};

let gpu: { dispose: () => void } | undefined;
let renderer: InstalledRenderer | undefined;
let testScene: TestScene | undefined; // boot frame + empty fallback (also the parity-test target)
// The instance-first layer registry: per-id scenes + the ordered visibility/opacity view. The
// worker composites the visible layers (M2.5a); pre-M4 the app drives exactly one.
const layers = new Map<string, LayerEntry>();
let composite: readonly CompositeEntry[] = [];
// The worker owns the cameras (lifted out of the scene factories): the perspective camera is
// pose-driven for volumes; the orthographic one is screen-aligned for slices + the boot triangle.
let perspCamera: PerspectiveCamera | undefined;
let orthoCamera: OrthographicCamera | undefined;
let pose: CameraPose = DEFAULT_POSE;
let dims = { width: 0, height: 0 };
// The init promise; renderFrame/upsertLayer await it so they can't race a half-built renderer
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

// The visible layers in draw order, each paired with the camera its projection needs (perspective
// for volumes, orthographic for slices), else the boot triangle. The renderer composites the list.
function paintItems(): CompositeItem[] {
  if (perspCamera === undefined || orthoCamera === undefined) {
    throw new Error("render before init");
  }
  const items: CompositeItem[] = [];
  for (const entry of composite) {
    if (!entry.visible) continue;
    const layer = layers.get(entry.id);
    if (layer === undefined) continue; // composite ahead of its upsert — heals on the upsert repaint
    items.push({
      scene: layer.scene.scene,
      camera: layer.kind === "volume" ? perspCamera : orthoCamera,
    });
  }
  if (items.length === 0) {
    if (testScene !== undefined) return [{ scene: testScene.scene, camera: orthoCamera }];
    throw new Error("no scene to render");
  }
  return items;
}

// The single repaint entry point for message handlers. Sets the dirty flag for the loop; if no loop
// is running (Node, or the init boot paint before startRenderLoop), renders synchronously instead.
function requestRender(): void {
  needsRender = true;
  if (rafId === undefined && renderer !== undefined) {
    renderer.renderComposite(paintItems());
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
  renderer.renderComposite(paintItems());
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
  const items = paintItems();
  // Deterministic readback renders to an offscreen target, then awaits the GPU. The only async gap
  // in the worker's single thread is that await — block the display loop's swapchain render across
  // it, else a rAF frame between the readback render and its await would corrupt the read pixels.
  readbackInFlight = true;
  try {
    const pixels = await renderer.readCompositePixels(items);
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

// Build or rebuild one layer's scene from a transferred field. Releases the prior scene's
// Data3DTexture before replacing it — else each swap leaks one.
async function upsertLayer(
  request: Extract<RenderWorkerRequest, { kind: "upsertLayer" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("upsertLayer before init");
  }
  layers.get(request.id)?.scene.dispose();
  const field = decodeSliceField(request.field);
  // exactOptionalPropertyTypes: only forward kind params that are set, so the scene defaults apply.
  const windowLevel = request.windowLevel !== undefined ? { windowLevel: request.windowLevel } : {};
  if (request.layerKind === "slice") {
    const scene = createSliceScene({
      field,
      colormap: request.colormap,
      scale: request.scale,
      axis: request.axis ?? "z",
      position: request.position ?? 0.5,
      opacity: request.opacity,
      ...windowLevel,
    });
    layers.set(request.id, { scene, kind: "slice" });
  } else {
    const scene = createRaymarchScene({
      field,
      colormap: request.colormap,
      scale: request.scale,
      opacity: request.opacity,
      ...windowLevel,
      ...(request.steps !== undefined ? { steps: request.steps } : {}),
      ...(request.density !== undefined ? { density: request.density } : {}),
    });
    layers.set(request.id, { scene, kind: "volume" });
  }
  requestRender();
}

async function removeLayer(
  request: Extract<RenderWorkerRequest, { kind: "removeLayer" }>,
): Promise<void> {
  await initDone;
  layers.get(request.id)?.scene.dispose();
  layers.delete(request.id);
  requestRender();
}

// Cheap reorder/visibility/opacity over the full ordered list — retune per-layer opacity uniforms
// (no rebuild) and repaint. Field data rides the heavier upsertLayer.
async function setComposite(
  request: Extract<RenderWorkerRequest, { kind: "setComposite" }>,
): Promise<void> {
  await initDone;
  const previous = new Map(composite.map((entry) => [entry.id, entry.opacity]));
  for (const entry of request.order) {
    if (previous.get(entry.id) !== entry.opacity)
      layers.get(entry.id)?.scene.setOpacity(entry.opacity);
  }
  composite = request.order;
  requestRender();
}

// Live per-layer color: one layer's resolved ColormapBinding (colormap + window/level + scale).
// Colormap rebake is idempotent, so a window-drag stream carrying the unchanged name is just a
// uniform retune + repaint — no scene rebuild.
async function setLayerColormap(
  request: Extract<RenderWorkerRequest, { kind: "setLayerColormap" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("setLayerColormap before init");
  }
  const entry = layers.get(request.id);
  if (entry === undefined) return; // binding update ahead of its upsert — heals on the upsert repaint
  entry.scene.setColormap(request.colormap);
  entry.scene.setWindowLevel(request.windowLevel.center, request.windowLevel.width);
  entry.scene.setScale(request.scale);
  requestRender();
}

// Live camera pose: re-aim the perspective camera and repaint. Only volumes are pose-driven, so a
// pose change with no visible volume layer is a no-op repaint we skip.
async function setCameraPose(
  request: Extract<RenderWorkerRequest, { kind: "setCameraPose" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined || perspCamera === undefined) {
    throw new Error("setCameraPose before init");
  }
  pose = request.pose;
  applyPose(perspCamera, pose, aspect());
  if (composite.some((entry) => entry.visible && layers.get(entry.id)?.kind === "volume")) {
    requestRender();
  }
}

function handle(request: RenderWorkerRequest): Promise<void> {
  switch (request.kind) {
    case "init":
      initDone = init(request);
      return initDone;
    case "renderFrame":
      return renderFrame(request);
    case "upsertLayer":
      return upsertLayer(request);
    case "removeLayer":
      return removeLayer(request);
    case "setComposite":
      return setComposite(request);
    case "setLayerColormap":
      return setLayerColormap(request);
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
  for (const layer of layers.values()) layer.scene.dispose();
  layers.clear();
  testScene?.dispose();
  renderer?.dispose();
  gpu?.dispose();
}
