import type { StreamStepMessage } from "@data";
import { getCapabilities, getDevice, installGpu, onDeviceLost, onDeviceRestored } from "@gpu";
import type { ColorScale, WindowLevel } from "@schema/colormap.ts";
import { type OrthographicCamera, type PerspectiveCamera, Vector3 } from "three";
import {
  applyPose,
  applyPoseOrtho,
  createOrthographicCamera,
  createPerspectiveCamera,
  createVolumeOrthographicCamera,
  DEFAULT_POSE,
} from "./camera.ts";
import { createFrameTimer, type FrameTimer } from "./frameTimer.ts";
import { createSceneOverlay, type SceneOverlay } from "./grid/overlayScene.ts";
import {
  advanceSettling,
  beginInteracting,
  endInteracting,
  QUALITY_FULL,
  type QualityLevel,
  type QualityState,
  qualityLevel,
} from "./interactionQuality.ts";
import type {
  CameraPose,
  CameraProjection,
  RenderWorkerRequest,
  RenderWorkerResponse,
  SceneOverlayConfig,
  SliceFieldPayload,
} from "./messages.ts";
import { fullRangeWindow } from "./normalization.ts";
import { type PickLayer, pickPointOnRay } from "./pickRay.ts";
import { createRaymarchScene, type RaymarchScene } from "./raymarchScene.ts";
import { type CompositeItem, type InstalledRenderer, installRenderer } from "./renderer.ts";
import { createTestScene, type TestScene } from "./scene.ts";
import { createSliceScene, type SliceAxis, type SliceScene } from "./sliceScene.ts";
import { finiteRange, type ScalarField } from "./volumeTexture.ts";

// Everything needed to rebuild a layer's scene without the main thread: the decoded field (its CPU
// buffer survives a GPU device loss) plus the live build params. field/colormap/scale/window/opacity
// are mutable — swapLayerField/setLayerColormap/setComposite update them so a device-loss rebuild
// reproduces the current state (the live timestep + look), not the stale upsert-time one. Retaining
// the field doubles its residency (CPU + GPU); fine for v0.1's one small volume, and the price of
// self-contained recovery (no reseed wire).
interface LayerSource {
  readonly layerKind: "slice" | "volume";
  field: ScalarField; // mutable: a streamed timestep swaps it in place (see swapLayerField)
  readonly axis?: SliceAxis;
  readonly position?: number;
  readonly steps?: number;
  readonly density?: number;
  colormap: string;
  scale: ColorScale;
  windowLevel?: WindowLevel;
  shaded?: boolean; // volume Phong toggle — mutable so a device-restore rebuild keeps the live state
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
// The RGB test triangle as the empty-layers frame is opt-in (init.debugScene — `?debugScene`, the
// parity test): handy "renderer alive, data missing" diagnostic, but as the default boot frame it
// was a disorienting flash. The user-facing boot/empty frame is the bare clear color instead.
let debugScene = false;
let testScene: TestScene | undefined;
// The instance-first layer registry: per-id scenes + the ordered visibility/opacity view. The
// worker composites the visible layers (M2.5a); pre-M4 the app drives exactly one.
const layers = new Map<string, LayerEntry>();
let composite: readonly CompositeEntry[] = [];
// The worker owns the cameras (lifted out of the scene factories): the pose-driven pair for
// volumes (perspective, plus the matched-frustum ortho the projection toggle swaps in) and the
// screen-aligned orthographic one for slices + the boot triangle.
let perspCamera: PerspectiveCamera | undefined;
let orthoVolumeCamera: OrthographicCamera | undefined;
let orthoCamera: OrthographicCamera | undefined;
let projection: CameraProjection = "perspective";
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

// The themeable axes + grid overlay (composited last, over the volume) + the config it was built from.
// overlaySource is retained so a device-restore rebuild reproduces the live overlay, mirroring how a
// layer retains its LayerSource. Labels are auto-billboarding Sprites, so no per-pose update is needed.
let overlay: SceneOverlay | undefined;
let overlaySource: SceneOverlayConfig | undefined;

// The data worker's end of the streaming MessageChannel (M2.10a). Stored on `pair`; its onmessage
// applies streamed timestep fields (data → render, no main hop). Closed on dispose.
let streamPort: MessagePort | undefined;

// Surface a worker-side fault without flooding: identical consecutive messages post once.
function reportError(message: string): void {
  if (message === lastErrorMessage) return;
  lastErrorMessage = message;
  ctx.postMessage({ kind: "error", requestId: -1, message });
}

function aspect(): number {
  return dims.height > 0 ? dims.width / dims.height : 1;
}

// The pose drives BOTH volume cameras (cheap — keeps the inactive one fresh so a projection flip
// never shows a stale frustum); compositeItems picks the active one by `projection`.
function applyVolumePose(): void {
  if (perspCamera !== undefined) applyPose(perspCamera, pose, aspect());
  if (orthoVolumeCamera !== undefined) applyPoseOrtho(orthoVolumeCamera, pose, aspect());
}

function volumeCamera(): PerspectiveCamera | OrthographicCamera | undefined {
  return projection === "orthographic" ? orthoVolumeCamera : perspCamera;
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
  orthoVolumeCamera = createVolumeOrthographicCamera(aspect());
  orthoCamera = createOrthographicCamera();
  applyVolumePose();
  debugScene = request.debugScene === true;
  if (debugScene) testScene = createTestScene();
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
  // Paint the boot frame synchronously (the loop isn't started yet) so "first frame" honestly
  // means a frame is on the swapchain before `ready` fires — the perf-gate contract. With no layers
  // yet that frame is the bare clear color, which matches the page background — a seamless boot.
  requestRender();
  ctx.postMessage({ kind: "ready", requestId: request.requestId });
  startRenderLoop();
}

// The visible layers in draw order, each paired with the camera its projection needs (perspective
// for volumes, orthographic for slices). `layerOverride` swaps in (or appends, when the composite
// doesn't list the id yet — the boot upsert precedes setComposite) a not-yet-committed scene, and
// `overlayOverride` a not-yet-committed overlay (null = none), so a warm can compile the
// *prospective* composite's pipelines before its commit makes it paintable.
function compositeItems(
  layerOverride?: { readonly id: string; readonly entry: LayerEntry },
  overlayOverride?: SceneOverlay | null,
): CompositeItem[] {
  const volume = volumeCamera();
  const ortho = orthoCamera;
  if (volume === undefined || ortho === undefined) {
    throw new Error("render before init");
  }
  const items: CompositeItem[] = [];
  let overrideListed = false;
  for (const entry of composite) {
    if (!entry.visible) continue;
    const isOverride = layerOverride !== undefined && entry.id === layerOverride.id;
    if (isOverride) overrideListed = true;
    const layer = isOverride ? layerOverride.entry : layers.get(entry.id);
    if (layer === undefined) continue; // composite ahead of its upsert — heals on the upsert repaint
    items.push({
      scene: layer.scene.scene,
      camera: layer.kind === "volume" ? volume : ortho,
    });
  }
  if (layerOverride !== undefined && !overrideListed) {
    items.push({
      scene: layerOverride.entry.scene.scene,
      camera: layerOverride.entry.kind === "volume" ? volume : ortho,
    });
  }
  // The overlay composites last (on top), paired with the SAME pose-driven camera as the volumes
  // (else the axes would misalign under an ortho volume) — and only when a volume layer is present.
  // A 3D axes overlay over a flat ortho slice or an empty frame is meaningless; a volume whose
  // upsert hasn't landed yet heals on its upsert repaint.
  const effectiveOverlay = overlayOverride === undefined ? overlay : (overlayOverride ?? undefined);
  if (effectiveOverlay !== undefined && items.some((item) => item.camera === volume)) {
    items.push({ scene: effectiveOverlay.scene, camera: volume });
  }
  return items;
}

// What the next paint draws: the composited layers, the opt-in debug triangle when empty, else
// nothing — renderComposite([]) presents the bare clear color, the flash-free boot/empty frame.
function paintItems(): CompositeItem[] {
  if (orthoCamera === undefined) {
    throw new Error("render before init");
  }
  const items = compositeItems();
  if (items.length === 0 && testScene !== undefined) {
    return [{ scene: testScene.scene, camera: orthoCamera }];
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
    // Each settle level paints exactly one frame: advancing re-arms needsRender via applyQuality
    // until the ramp lands at full, where the level stops changing and the loop goes quiet.
    if (quality.kind === "settling") {
      quality = advanceSettling(quality);
      applyQuality();
    }
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
    ...(source.shaded !== undefined ? { shaded: source.shaded } : {}),
  });
  // A scene built mid-gesture (stream rebuild) inherits the live interaction quality + projection.
  scene.setStepScale(qualityLevel(quality).stepScale);
  scene.setProjection(projection === "orthographic");
  return { scene, kind: "volume", source };
}

// Superseding guard for the async warms: an id's epoch bumps on every replace/remove (and on a
// device rebuild), so a warm that loses the race discards its scene instead of committing a stale one.
const layerEpochs = new Map<string, number>();

function bumpLayerEpoch(id: string): number {
  const next = (layerEpochs.get(id) ?? 0) + 1;
  layerEpochs.set(id, next);
  return next;
}

// Install a layer's scene from a fully-specified source, releasing the prior scene's Data3DTexture
// without leaking. Warm-then-commit: the prospective composite's pipelines compile asynchronously
// (createRenderPipelineAsync, off the render path) before the swap, so the new scene's first visible
// frame neither stalls on a sync compile nor draws half-formed. Swap-then-defer on commit: the new
// scene is live in the map before the old one's GPUTextures are released, and the release waits one
// rebuild so an in-flight rAF frame never samples a destroyed texture. Used by upsertLayer (main)
// and as swapLayerField's fallback when an in-place ping-pong upload can't apply (the common
// streamed step takes the in-place path, not this rebuild).
async function replaceLayer(id: string, source: LayerSource): Promise<void> {
  const epoch = bumpLayerEpoch(id);
  const next = buildScene(source);
  try {
    await renderer?.compileComposite(compositeItems({ id, entry: next }));
  } catch (error) {
    // A failed warm must not block the commit — the paint falls back to the sync compile.
    reportError(error instanceof Error ? error.message : String(error));
  }
  if (layerEpochs.get(id) !== epoch) {
    next.scene.dispose(); // superseded mid-warm — discard rather than resurrect a stale scene
    return;
  }
  // The warm's await is a real yield: a setProjection / quality change that landed mid-warm only
  // reached committed scenes, so re-assert the live state on this one before it becomes visible.
  if ("setStepScale" in next.scene) next.scene.setStepScale(qualityLevel(quality).stepScale);
  if ("setProjection" in next.scene) next.scene.setProjection(projection === "orthographic");
  const previous = layers.get(id);
  layers.set(id, next);
  pendingDispose?.scene.dispose();
  pendingDispose = previous;
  requestRender();
}

// Build or rebuild one layer's scene from a transferred field (main → render).
async function upsertLayer(
  request: Extract<RenderWorkerRequest, { kind: "upsertLayer" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("upsertLayer before init");
  }
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
    ...(request.shaded !== undefined ? { shaded: request.shaded } : {}),
  };
  await replaceLayer(request.id, source);
}

// A streamed timestep's scalar (data worker → render, over the paired port): swap only the field on
// an existing layer, keeping its retained look (colormap/scale/window/opacity/shaded). The layer is
// created by main's initial upsertLayer; a step arriving before it (or after a remove) is ignored —
// it heals on the next upsert, mirroring setLayerColormap.
//
// The swap is an in-place ping-pong (M2.10b): the scene uploads the field into its inactive
// Data3DTexture and re-binds — reusing geometry/material/transfer-function, no 64 MiB pipeline
// rebuild per step. We retain the field on the source so a device-restore rebuild reproduces the
// *live* timestep. If the scene declines the in-place swap (a shape change, or an empty-space-skip
// volume whose acceleration grid would go stale), fall back to a full rebuild.
function swapLayerField(message: StreamStepMessage): void {
  const entry = layers.get(message.id);
  if (entry === undefined) return;
  const field = decodeSliceField(message.field);
  if (entry.scene.setField(field)) {
    // Retain the live step so a device-restore rebuild reproduces the on-screen field (not stale
    // step 0). The retained windowLevel keeps the colors fixed too — EXCEPT on the defensive
    // no-window path (source.windowLevel undefined), where a rebuild would renormalize to the live
    // step's range (buildScene → createNormalization → full-range). That can't happen in the app:
    // a streamed layer always carries a seeded binding's window (layerSync), so windowLevel is set.
    entry.source.field = field;
    requestRender();
    return;
  }
  // Fire-and-forget: the stream port's onmessage can't await; a failed rebuild is reported and the
  // next streamed step retries through the same path.
  void replaceLayer(message.id, { ...entry.source, field }).catch((error: unknown) => {
    reportError(error instanceof Error ? error.message : String(error));
  });
}

async function removeLayer(
  request: Extract<RenderWorkerRequest, { kind: "removeLayer" }>,
): Promise<void> {
  await initDone;
  bumpLayerEpoch(request.id); // an in-flight warm for this id must not resurrect the removed layer
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

// Camera-gesture liveness → interaction-time quality: volumes march coarser (uniform flip, no
// rebuild) AND the swapchain renders at a reduced scale while a gesture is live; the false edge
// starts a short settle ramp the display loop advances one painted frame at a time, instead of a
// one-frame pop back to full quality. State transitions are pure (interactionQuality.ts).
let quality: QualityState = QUALITY_FULL;
let appliedLevel: QualityLevel = qualityLevel(QUALITY_FULL);

function applyQuality(): void {
  const level = qualityLevel(quality);
  let changed = false;
  if (level.stepScale !== appliedLevel.stepScale) {
    for (const entry of layers.values()) {
      if ("setStepScale" in entry.scene) entry.scene.setStepScale(level.stepScale);
    }
    changed = true;
  }
  if (level.renderScale !== appliedLevel.renderScale) {
    renderer?.setRenderScale(level.renderScale);
    changed = true;
  }
  appliedLevel = level;
  if (changed) requestRender();
}

async function setInteracting(
  request: Extract<RenderWorkerRequest, { kind: "setInteracting" }>,
): Promise<void> {
  await initDone;
  quality = request.interacting ? beginInteracting() : endInteracting(quality);
  // No display loop (Node) means nothing advances a settle ramp — collapse straight to full so
  // the synchronous one-shot paints land at final quality.
  if (rafId === undefined && quality.kind === "settling") quality = QUALITY_FULL;
  applyQuality();
}

// Live per-layer Phong toggle — a uniform flip on the volume scene, no rebuild/re-upload. Slice
// layers have no shading normal, so the message is inert for them (no scene method to call).
async function setLayerShading(
  request: Extract<RenderWorkerRequest, { kind: "setLayerShading" }>,
): Promise<void> {
  await initDone;
  const entry = layers.get(request.id);
  if (entry === undefined) return; // toggle ahead of its upsert — heals on the upsert (carries shaded)
  // `setShading` exists only on RaymarchScene; the `in` check narrows the SliceScene | RaymarchScene
  // union (and silently no-ops a slice — it has no normal to light).
  if ("setShading" in entry.scene) {
    entry.scene.setShading(request.shaded);
    entry.source.shaded = request.shaded; // retain for a device-restore rebuild
    requestRender();
  }
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
  applyVolumePose();
  requestRender();
}

// Volume-view projection flip: pick the other pose-driven camera and flip every volume scene's
// ray generation (a uniform — no rebuild). The matched ortho frustum (halfH = d·tan(fov/2)) keeps
// the on-screen scale at the target plane, so the flip is visually seamless except for parallax.
async function setProjection(
  request: Extract<RenderWorkerRequest, { kind: "setProjection" }>,
): Promise<void> {
  await initDone;
  if (projection === request.projection) return;
  projection = request.projection;
  applyVolumePose(); // the incoming camera re-aims at the live pose before it paints
  const orthographic = projection === "orthographic";
  for (const entry of layers.values()) {
    // `setProjection` exists only on RaymarchScene; the `in` check narrows the union (slices are
    // screen-aligned and pose-invariant, so the flip is inert for them).
    if ("setProjection" in entry.scene) entry.scene.setProjection(orthographic);
  }
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
  applyVolumePose(); // re-applies both cameras' aspect
  requestRender();
}

// Rebuild the renderer + every scene on the device gpu/ re-acquired after a loss. The old renderer
// and all GPU textures belong to the dead device; the layers' CPU sources survive, so scenes rebuild
// locally with no main↔worker reseed. The loop stays paused (deviceLost) until this completes.
async function rebuildOnDevice(device: GPUDevice): Promise<void> {
  if (canvas === undefined) return; // pre-init loss — nothing to rebuild yet
  // Any in-flight warm raced the loss: bump every epoch so its commit discards (a superseded
  // streamed field heals on the next step) instead of landing a dead-device scene post-rebuild.
  for (const id of layers.keys()) bumpLayerEpoch(id);
  overlayEpoch += 1;
  // Drop the dead-device resources best-effort: disposing GPU handles on a lost device can throw,
  // and the fresh renderer below is what matters.
  try {
    renderer?.dispose();
    for (const layer of layers.values()) layer.scene.dispose();
    pendingDispose?.scene.dispose();
    overlay?.dispose();
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
  if (debugScene) testScene = createTestScene();
  applyVolumePose();
  // Replace each layer's scene in place (Map.set on an existing key is safe mid-iteration).
  for (const [id, entry] of layers) layers.set(id, buildScene(entry.source));
  // Replay the overlay from its retained config on the fresh device (its line buffers + CanvasTextures
  // belonged to the dead device). Sprites re-billboard on the next render.
  overlay = overlaySource !== undefined ? createSceneOverlay(overlaySource) : undefined;
  // The fresh renderer starts at scale 1 and buildScene already applied the live step scale —
  // resync the applied-level cache, then re-apply in case a gesture is live across the restore.
  appliedLevel = { stepScale: qualityLevel(quality).stepScale, renderScale: 1 };
  applyQuality();
  // Warm the rebuilt composite on the fresh device before un-pausing the loop, so the first
  // restored frame neither stalls nor draws half-compiled.
  try {
    await renderer.compileComposite(paintItems());
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
  }
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

// Build/replace the axes + grid overlay from a config (or tear it down on null). Warm-then-commit
// like replaceLayer — the warm also compiles the volume's pipelines for the ≥2-layer composite
// context this overlay usually activates. New scene live before the old one's GPU resources are
// freed — the overlay has no readback-borrowed texture, so a same-tick dispose is safe (unlike
// replaceLayer's deferral). Retains the source for a device-restore rebuild.
let overlayEpoch = 0;

async function buildOverlay(config: SceneOverlayConfig | null): Promise<void> {
  const epoch = ++overlayEpoch;
  const next = config !== null ? createSceneOverlay(config) : undefined;
  if (next !== undefined) {
    try {
      await renderer?.compileComposite(compositeItems(undefined, next));
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    }
    if (overlayEpoch !== epoch) {
      next.dispose(); // superseded mid-warm
      return;
    }
  }
  const previous = overlay;
  overlay = next;
  overlaySource = config ?? undefined;
  previous?.dispose();
  requestRender();
}

async function setSceneOverlay(
  request: Extract<RenderWorkerRequest, { kind: "setSceneOverlay" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("setSceneOverlay before init");
  }
  await buildOverlay(request.overlay);
}

// Pick-to-focus: march the cursor ray through the retained CPU fields (no GPU round-trip) and
// reply with the focus point. The ray comes from the live volume camera via unproject so it matches
// the rendered frame exactly — projection flip, aspect, and the pose this click saw (postMessage
// ordering) included. The unit box has the identity transform, so world = object space.
async function pickRay(request: Extract<RenderWorkerRequest, { kind: "pickRay" }>): Promise<void> {
  await initDone;
  const camera = volumeCamera();
  if (camera === undefined) {
    throw new Error("pickRay before init");
  }
  camera.updateMatrixWorld(); // unproject outside a render needs fresh matrices
  const near = new Vector3(request.ndcX, request.ndcY, -1).unproject(camera);
  const far = new Vector3(request.ndcX, request.ndcY, 1).unproject(camera);
  const dir = far.sub(near).normalize();
  // A source with no windowLevel normalizes over its full finite range (buildScene's default) —
  // the in-app path always carries a binding window, so the scan is the defensive branch only.
  const pickWindow = (source: LayerSource): WindowLevel => {
    if (source.windowLevel !== undefined) return source.windowLevel;
    const { min, max } = finiteRange(source.field.data);
    return fullRangeWindow(min, max);
  };
  const pickLayers: PickLayer[] = [];
  for (const entry of composite) {
    if (!entry.visible) continue;
    const layer = layers.get(entry.id);
    if (layer === undefined || layer.kind !== "volume") continue;
    pickLayers.push({
      field: layer.source.field,
      windowLevel: pickWindow(layer.source),
      scale: layer.source.scale,
      density: layer.source.density ?? 1, // the scene factory default
      opacity: entry.opacity,
    });
  }
  const point = pickPointOnRay([near.x, near.y, near.z], [dir.x, dir.y, dir.z], pickLayers);
  ctx.postMessage({ kind: "pickResult", requestId: request.requestId, point });
}

// Pair with the data worker's streaming port (M2.10a). Assigning onmessage implicitly starts the
// port, so streamStep messages posted before this pairing drain here in order — no lost frames.
async function pair(request: Extract<RenderWorkerRequest, { kind: "pair" }>): Promise<void> {
  await initDone;
  streamPort?.close();
  streamPort = request.port;
  streamPort.onmessage = (event: MessageEvent<StreamStepMessage>) => {
    try {
      swapLayerField(event.data);
    } catch (error) {
      reportError(error instanceof Error ? error.message : String(error));
    }
  };
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
    case "setLayerShading":
      return setLayerShading(request);
    case "setCameraPose":
      return setCameraPose(request);
    case "setProjection":
      return setProjection(request);
    case "resize":
      return resize(request);
    case "setContinuous":
      return setContinuous(request);
    case "setInteracting":
      return setInteracting(request);
    case "setSceneOverlay":
      return setSceneOverlay(request);
    case "pickRay":
      return pickRay(request);
    case "pair":
      return pair(request);
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
  streamPort?.close();
  streamPort = undefined;
  stopRenderLoop();
  for (const layer of layers.values()) layer.scene.dispose();
  layers.clear();
  pendingDispose?.scene.dispose();
  pendingDispose = undefined;
  overlay?.dispose();
  overlay = undefined;
  overlaySource = undefined;
  testScene?.dispose();
  renderer?.dispose();
  gpu?.dispose();
}
