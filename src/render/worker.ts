import { getCapabilities, getDevice, installGpu, onDeviceLost, onDeviceRestored } from "@gpu";
import type { ColorScale, WindowLevel } from "@schema/colormap.ts";
import type { OrthographicCamera, PerspectiveCamera } from "three";
import {
  applyPose,
  createOrthographicCamera,
  createPerspectiveCamera,
  DEFAULT_POSE,
} from "./camera.ts";
import { createFrameTimer, type FrameTimer } from "./frameTimer.ts";
import type {
  CameraPose,
  RenderWorkerRequest,
  RenderWorkerResponse,
  SliceFieldPayload,
} from "./messages.ts";
import { createRaymarchScene, type RaymarchScene } from "./raymarchScene.ts";
import { type CompositeItem, type InstalledRenderer, installRenderer } from "./renderer.ts";
import { createTestScene, type TestScene } from "./scene.ts";
import { createSliceScene, type SliceAxis, type SliceScene } from "./sliceScene.ts";
import type { ScalarField } from "./volumeTexture.ts";

// Everything needed to rebuild a layer's scene without the main thread: the decoded field (its CPU
// buffer survives a GPU device loss) plus the live build params. colormap/scale/window/opacity are
// mutable — setLayerColormap/setComposite update them so a device-loss rebuild reproduces the
// current look, not the stale upsert-time one. Retaining the field doubles its residency (CPU +
// GPU); fine for v0.1's one small volume, and the price of self-contained recovery (no reseed wire).
interface LayerSource {
  readonly layerKind: "slice" | "volume";
  readonly field: ScalarField;
  readonly axis?: SliceAxis;
  readonly position?: number;
  readonly steps?: number;
  readonly density?: number;
  colormap: string;
  scale: ColorScale;
  windowLevel?: WindowLevel;
  opacity: number;
}

// One renderable layer's scene + its kind (the kind picks the camera at composite time) + the source
// it was built from (replayed on device-restore).
interface LayerEntry {
  readonly scene: SliceScene | RaymarchScene;
  readonly kind: "slice" | "volume";
  readonly source: LayerSource;
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
let canvas: OffscreenCanvas | undefined; // retained to rebuild the renderer on device-restore
let devicePixelRatio = 1; // retained for the rebuild's drawing-buffer scale
let float32Filterable = false; // R32F linear volume texture when the device supports it
// device.lost recovery: gpu/ re-acquires the device and emits onDeviceRestored; render/ must rebuild
// the renderer + every scene on the new device (the old ones hold dead GPU handles). Without this a
// recoverable loss is a permanent frozen swapchain.
let deviceLost = false; // pauses the loop between loss and restore
let unsubscribeGpu: (() => void) | undefined;
// The init promise; renderFrame/upsertLayer await it so they can't race a half-built renderer
// even if a future caller stops gating on the `ready` response.
let initDone: Promise<void> | undefined;

// Display-loop state. The loop runs in browser workers (requestAnimationFrame present); in Node it
// stays dormant and requestRender() paints synchronously, preserving the old one-shot behavior.
let needsRender = false; // on-demand: the loop paints only when something changed
let rafId: number | undefined; // undefined ⇒ no loop running
let readbackInFlight = false; // pauses the loop across a deterministic readPixels (see renderFrame)
let continuous = false; // diagnostics: force every-frame repaints for sustained GPU timing
let frameTimer: FrameTimer | undefined; // per-frame GPU timing (timestamp-query or wall-clock)
let lastErrorMessage: string | undefined; // dedupe so a persistent bad frame can't flood the channel

// One scene whose dispose is deferred by a swap so the rAF loop can't sample a GPUTexture that
// upsertLayer just released mid-rebuild (use-after-free reads back as the magenta sentinel).
let pendingDispose: LayerEntry | undefined;

// Surface a worker-side fault without flooding: identical consecutive messages post once.
function reportError(message: string): void {
  if (message === lastErrorMessage) return;
  lastErrorMessage = message;
  ctx.postMessage({ kind: "error", requestId: -1, message });
}

function aspect(): number {
  return dims.height > 0 ? dims.width / dims.height : 1;
}

async function init(request: Extract<RenderWorkerRequest, { kind: "init" }>): Promise<void> {
  gpu = await installGpu();
  canvas = request.canvas;
  devicePixelRatio = request.devicePixelRatio;
  renderer = await installRenderer({
    canvas: request.canvas,
    width: request.width,
    height: request.height,
    devicePixelRatio,
    device: getDevice(),
  });
  dims = { width: request.width, height: request.height };
  float32Filterable = getCapabilities().hasFloat32Filterable;
  frameTimer = createFrameTimer(getDevice());
  perspCamera = createPerspectiveCamera(aspect());
  orthoCamera = createOrthographicCamera();
  applyPose(perspCamera, pose, aspect());
  testScene = createTestScene();
  // Rebuild the renderer + scenes on the device gpu/ re-acquires after a loss; until then the loop
  // pauses (deviceLost) instead of painting a dead device into a frozen/magenta swapchain.
  const offLost = onDeviceLost((event) => {
    deviceLost = true;
    if (event.terminal) {
      // Recovery gave up (breaker tripped or no adapter) — halt the loop so nothing hammers the dead
      // GPU, and tell the app to show a terminal "reload" state instead of spiraling.
      stopRenderLoop();
      const reason = event.message.includes("GPUAdapter") ? "no-adapter" : "repeated-loss";
      ctx.postMessage({ kind: "gpuRecoveryFailed", requestId: -1, reason, message: event.message });
    } else {
      reportError(`WebGPU device lost (${event.kind}): ${event.message}`);
    }
  });
  const offRestored = onDeviceRestored((device) => {
    void rebuildOnDevice(device).catch((error: unknown) => {
      reportError(error instanceof Error ? error.message : String(error));
    });
  });
  unsubscribeGpu = () => {
    offLost();
    offRestored();
  };
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
  if (rafId === undefined && renderer !== undefined && !deviceLost) {
    renderer.renderComposite(paintItems());
    needsRender = false;
  }
}

function renderTick(): void {
  // Reschedule first so a throwing frame can't permanently strand the loop.
  rafId = requestAnimationFrame(renderTick);
  if (readbackInFlight || renderer === undefined || deviceLost) return;
  // Continuous mode repaints every frame for sustained GPU timing; otherwise paint only on change.
  if (!needsRender && !continuous) return;
  needsRender = false;
  try {
    // GPU timing only while measuring (continuous): its onSubmittedWorkDone bracket is a GPU sync,
    // so on-demand interactive frames skip it entirely and stay smooth.
    if (continuous) {
      frameTimer?.beginFrame();
      renderer.renderComposite(paintItems());
      void sampleAndPostTiming().catch((error: unknown) => {
        reportError(error instanceof Error ? error.message : String(error));
      });
    } else {
      renderer.renderComposite(paintItems());
    }
    lastErrorMessage = undefined; // a clean frame re-arms error reporting
  } catch (error) {
    // A single bad frame (transient validation, mid-rebuild sample) must not kill the loop; on-demand
    // mode won't re-enter until the next requestRender, so this self-rate-limits to real changes.
    reportError(error instanceof Error ? error.message : String(error));
  }
}

// Read the just-submitted frame's GPU time and post it. Fire-and-forget off the loop: the read is
// async (and NaNs for in-flight / bad samples the timer rejects) — skip those rather than back up
// the loop. The timer guarantees a valid ms or NaN, so no plausibility filter is needed here.
async function sampleAndPostTiming(): Promise<void> {
  if (frameTimer === undefined) return;
  const gpuTimeMs = await frameTimer.sampleAfterSubmit();
  if (Number.isNaN(gpuTimeMs)) return;
  ctx.postMessage({ kind: "frameTiming", gpuTimeMs, clock: frameTimer.mode });
}

function startRenderLoop(): void {
  if (rafId !== undefined) return; // idempotent
  if (typeof requestAnimationFrame !== "function") return; // Node: requestRender paints synchronously
  rafId = requestAnimationFrame(renderTick);
}

function stopRenderLoop(): void {
  if (rafId !== undefined && typeof cancelAnimationFrame === "function")
    cancelAnimationFrame(rafId);
  rafId = undefined;
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

// Build one layer's scene from its retained source — the single build path, shared by upsertLayer
// and the device-restore rebuild so both produce an identical scene from the same params.
// exactOptionalPropertyTypes: only forward params that are set, so the scene factory defaults apply.
function buildScene(source: LayerSource): LayerEntry {
  const windowLevel = source.windowLevel !== undefined ? { windowLevel: source.windowLevel } : {};
  if (source.layerKind === "slice") {
    const scene = createSliceScene({
      field: source.field,
      colormap: source.colormap,
      scale: source.scale,
      axis: source.axis ?? "z",
      position: source.position ?? 0.5,
      opacity: source.opacity,
      float32Filterable,
      ...windowLevel,
    });
    return { scene, kind: "slice", source };
  }
  const scene = createRaymarchScene({
    field: source.field,
    colormap: source.colormap,
    scale: source.scale,
    opacity: source.opacity,
    float32Filterable,
    ...windowLevel,
    ...(source.steps !== undefined ? { steps: source.steps } : {}),
    ...(source.density !== undefined ? { density: source.density } : {}),
  });
  return { scene, kind: "volume", source };
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
  const previous = layers.get(request.id);
  const source: LayerSource = {
    layerKind: request.layerKind,
    field: decodeSliceField(request.field),
    colormap: request.colormap,
    scale: request.scale,
    opacity: request.opacity,
    ...(request.windowLevel !== undefined ? { windowLevel: request.windowLevel } : {}),
    ...(request.axis !== undefined ? { axis: request.axis } : {}),
    ...(request.position !== undefined ? { position: request.position } : {}),
    ...(request.steps !== undefined ? { steps: request.steps } : {}),
    ...(request.density !== undefined ? { density: request.density } : {}),
  };
  layers.set(request.id, buildScene(source));
  // Swap-then-defer: the new scene is live in the map before the old one's GPUTextures are released,
  // and the release waits one rebuild so an in-flight rAF frame never samples a destroyed texture.
  pendingDispose?.scene.dispose();
  pendingDispose = previous;
  requestRender();
}

async function removeLayer(
  request: Extract<RenderWorkerRequest, { kind: "removeLayer" }>,
): Promise<void> {
  await initDone;
  const entry = layers.get(request.id);
  layers.delete(request.id);
  if (entry !== undefined) {
    // Same one-frame deferral as upsertLayer — the old composite may still list this id for a tick.
    pendingDispose?.scene.dispose();
    pendingDispose = entry;
  }
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
    if (previous.get(entry.id) === entry.opacity) continue;
    const layer = layers.get(entry.id);
    if (layer === undefined) continue;
    layer.scene.setOpacity(entry.opacity);
    layer.source.opacity = entry.opacity; // keep the retained source current for a device-restore rebuild
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
  // Keep the retained source current so a device-restore rebuild reproduces the live color.
  entry.source.colormap = request.colormap;
  entry.source.windowLevel = request.windowLevel;
  entry.source.scale = request.scale;
  requestRender();
}

// Live camera pose: re-aim the perspective camera and repaint. Always repaints — a volume-only
// guard here silently drops the frame during composite-build races and visibility toggles, leaving
// the 3D view stale while the (independently store-driven) gnomon keeps turning. Slices stay
// pose-invariant via the ortho camera, so an unconditional repaint just re-presents them.
async function setCameraPose(
  request: Extract<RenderWorkerRequest, { kind: "setCameraPose" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined || perspCamera === undefined) {
    throw new Error("setCameraPose before init");
  }
  pose = request.pose;
  applyPose(perspCamera, pose, aspect());
  requestRender();
}

// Viewport resize: re-size the swapchain + readback targets, fix the perspective aspect, repaint.
async function resize(request: Extract<RenderWorkerRequest, { kind: "resize" }>): Promise<void> {
  await initDone;
  if (renderer === undefined || perspCamera === undefined) {
    throw new Error("resize before init");
  }
  dims = { width: request.width, height: request.height };
  devicePixelRatio = request.devicePixelRatio;
  renderer.setSize(request.width, request.height, request.devicePixelRatio);
  applyPose(perspCamera, pose, aspect()); // re-applies camera.aspect via its internal guard
  requestRender();
}

// Rebuild the renderer + every scene on the device gpu/ re-acquired after a loss. The old renderer
// and all GPU textures belong to the dead device; the layers' CPU sources survive, so scenes rebuild
// locally with no main↔worker reseed. The loop stays paused (deviceLost) until this completes.
async function rebuildOnDevice(device: GPUDevice): Promise<void> {
  if (canvas === undefined) return; // pre-init loss — nothing to rebuild yet
  // Drop the dead-device resources best-effort: disposing GPU handles on a lost device can throw,
  // and the fresh renderer below is what matters.
  try {
    renderer?.dispose();
    for (const layer of layers.values()) layer.scene.dispose();
    pendingDispose?.scene.dispose();
    testScene?.dispose();
  } catch {
    // a lost device throws on teardown — ignore; we're replacing everything anyway
  }
  pendingDispose = undefined;
  renderer = await installRenderer({
    canvas,
    width: dims.width,
    height: dims.height,
    devicePixelRatio,
    device,
  });
  frameTimer = createFrameTimer(device);
  testScene = createTestScene();
  if (perspCamera !== undefined) applyPose(perspCamera, pose, aspect());
  // Replace each layer's scene in place (Map.set on an existing key is safe mid-iteration).
  for (const [id, entry] of layers) layers.set(id, buildScene(entry.source));
  deviceLost = false;
  requestRender();
}

// Toggle sustained every-frame measurement. Kicks the loop on enable; the rAF loop carries it from
// there. Inert in Node (no loop) — continuous timing is a browser concern.
async function setContinuous(
  request: Extract<RenderWorkerRequest, { kind: "setContinuous" }>,
): Promise<void> {
  await initDone;
  continuous = request.continuous;
  if (continuous) needsRender = true;
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
    case "resize":
      return resize(request);
    case "setContinuous":
      return setContinuous(request);
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
  unsubscribeGpu?.();
  unsubscribeGpu = undefined;
  stopRenderLoop();
  for (const layer of layers.values()) layer.scene.dispose();
  layers.clear();
  pendingDispose?.scene.dispose();
  pendingDispose = undefined;
  testScene?.dispose();
  renderer?.dispose();
  gpu?.dispose();
}
