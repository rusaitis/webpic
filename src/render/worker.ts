import { readHeapBytes } from "@containers/perf_probe.ts";
import type { StreamStepMessage } from "@data";
import { getCapabilities, getDevice, installGpu, resetLedger, vramSnapshot } from "@gpu";
import { type OrthographicCamera, type PerspectiveCamera, Vector3 } from "three";
import { DEFAULT_POSE } from "./camera/camera.ts";
import { type CameraRig, createCameraRig } from "./camera/cameraRig.ts";
import { createManagedOverlay } from "./grid/managedOverlay.ts";
import type { SceneOverlay } from "./grid/overlayScene.ts";
import { createLayerRegistry, type LayerEntry } from "./layerRegistry.ts";
import { createManagedMarker } from "./marker/managedMarker.ts";
import type { MarkerScene } from "./marker/markerScene.ts";
import type {
  CameraMotion,
  CameraPose,
  CameraProjection,
  RenderWorkerRequest,
  RenderWorkerResponse,
} from "./messages.ts";
import { pickPointOnRay } from "./pickRay.ts";
import type { RenderModule } from "./renderModule.ts";
import { createDeviceRecovery } from "./runtime/deviceRecovery.ts";
import { createFrameTimer, type FrameTimer } from "./runtime/frameTimer.ts";
import { createQualityController } from "./runtime/qualityController.ts";
import { type CompositeItem, type InstalledRenderer, installRenderer } from "./runtime/renderer.ts";
import { createRenderLoop } from "./runtime/renderLoop.ts";
import { createTestScene, type TestScene } from "./scene.ts";

// Worker-scope view of `self`. The DOM lib types `self` as Window (whose
// postMessage wants a targetOrigin), so narrow it to the dedicated-worker surface.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<RenderWorkerRequest>) => void) | null;
  postMessage(message: RenderWorkerResponse, transfer?: Transferable[]): void;
};

let renderer: InstalledRenderer | undefined;
// The RGB test triangle as the empty-layers frame is opt-in (init.debugScene — `?debugScene`, the
// parity test): handy "renderer alive, data missing" diagnostic, but as the default boot frame it
// was a disorienting flash. The user-facing boot/empty frame is the bare clear color instead.
let isDebugScene = false;
let testScene: TestScene | undefined;
// The worker's cameras (cameraRig): the pose-driven volume pair + the screen-aligned ortho for slices
// + boot. Created in init; survives a device loss (pure JS matrices, no GPU resources).
let rig: CameraRig | undefined;
let projection: CameraProjection = "perspective";
let pose: CameraPose = DEFAULT_POSE;
let dims = { width: 0, height: 0 };
let canvas: OffscreenCanvas | undefined; // retained to rebuild the renderer on device-restore
let devicePixelRatio = 1; // retained for the rebuild's drawing-buffer scale
let float32Filterable = false; // R32F linear volume texture when the device supports it
// The init promise; renderFrame/upsertLayer await it so they can't race a half-built renderer
// even if a future caller stops gating on the `ready` response.
let initDone: Promise<void> | undefined;

let frameTimer: FrameTimer | undefined; // per-frame GPU timing (timestamp-query or wall-clock)
let lastErrorMessage: string | undefined; // dedupe so a persistent bad frame can't flood the channel

// Dev perf HUD sampling state — dormant unless setPerfActive(true). The CPU-encode bracket + painted-
// frame interval EMA cost ~nothing per frame; the GPU wall-clock sync (onSubmittedWorkDone) is
// throttled to PERF_GPU_SAMPLE_MS so it can't perturb a sustained gesture, and only ever rides frames
// already painting — it never forces one (renderLoop.setPerfActive deliberately doesn't re-dirty).
const PERF_GPU_SAMPLE_MS = 200; // ≤5 Hz GPU sync
const PERF_EMA_ALPHA = 0.2; // painted-frame interval smoothing
const PERF_IDLE_GAP_MS = 500; // a longer gap means we resumed after idle — don't fold it into the EMA
const VRAM_TOP_N = 5; // largest tracked allocations surfaced in the HUD detail panel
let perfActive = false;
let lastPaintMs = Number.NaN;
let frameIntervalEma = Number.NaN;
let lastGpuSampleMs = Number.NaN;

// The data worker's end of the streaming MessageChannel. Stored on `pair`; its onmessage
// applies streamed timestep fields (data → render, no main hop). Closed on dispose.
let streamPort: MessagePort | undefined;

// Surface a worker-side fault without flooding: identical consecutive messages post once.
function reportError(message: string): void {
  if (message === lastErrorMessage) return;
  lastErrorMessage = message;
  ctx.postMessage({ kind: "error", requestId: -1, message });
}

// Same, from a caught `unknown` (the warm-then-commit + fire-and-forget catch sites).
function reportFault(error: unknown): void {
  reportError(error instanceof Error ? error.message : String(error));
}

// Camera-motion liveness → quality tier: volumes march coarser (uniform flip, no rebuild) AND the
// swapchain renders at a reduced scale while a gesture is live; machine-driven flies keep full
// resolution with a mildly coarser march; the idle edge starts a short settle ramp the display loop
// advances one painted frame at a time, instead of a one-frame pop back to full quality. The
// controller owns the state machine; the loop and device-restore drive it through the seam.
const quality = createQualityController({
  hasLoop: () => loop.isRunning(),
  applyStepScale: (stepScale) => registry.applyStepScale(stepScale),
  setRenderScale: (scale) => renderer?.setRenderScale(scale),
  requestRender,
});

// Two independent interaction-liveness sources feed the one quality tier: camera motion
// (setCameraMotion) and a live marker manipulation (setPickerPoint's `active` — a drag or a held-arrow
// slide). A marker move re-marches the whole volume per frame, so it must coarsen the same way an orbit
// does; without this a marker drag renders at full res + full step density and stutters under Phong.
// OR-merged so a hand gesture (either source) dominates a machine fly, and releasing one source never
// settles while the other is still live.
let cameraMotion: CameraMotion = "idle";
let isPickerActive = false;

function syncQualityMotion(): void {
  const motion: CameraMotion =
    cameraMotion === "gesture" || isPickerActive
      ? "gesture"
      : cameraMotion === "fly"
        ? "fly"
        : "idle";
  quality.setMotion(motion);
}

// The renderable layers + their lifecycle (build/replace/remove, composite, color/shading, the
// warm-then-commit, the device-restore replay). It reaches back for live quality/projection + the
// repaint/fault seams, and warms the FULL composite — overlay + marker live here, so the worker
// assembles it via compositeItems.
const registry = createLayerRegistry({
  float32Filterable: () => float32Filterable,
  stepScale: () => quality.stepScale(),
  isOrthographic: () => projection === "orthographic",
  requestRender,
  reportFault,
  warmComposite: ({ id, entry }) => renderer?.compileComposite(compositeItems({ id, entry })),
});

// The themeable axes + grid overlay's lifecycle (build/replace, warm-then-commit, device-restore
// replay), composited last over the volume. The worker owns the composite, so the warm flows back
// through warmComposite — which compiles the full prospective composite (overlay spliced in).
const overlay = createManagedOverlay({
  requestRender,
  reportFault,
  warmComposite: (scene) => renderer?.compileComposite(compositeItems(undefined, scene)),
});

// The draggable point-picker marker's lifecycle + live position/state + easing clock, composited last
// over the volume + overlay. Reads the live pose from the worker; warms the full composite like the overlay.
const marker = createManagedMarker({
  pose: () => pose,
  isOrthographic: () => projection === "orthographic",
  requestRender,
  reportFault,
  warmComposite: (scene) => renderer?.compileComposite(compositeItems(undefined, undefined, scene)),
});

// Every managed render subsystem, viewed through its RenderModule lifecycle face. The device-restore
// host and dispose() iterate this instead of naming each manager — a new renderable is one more entry.
// ORDER IS LOAD-BEARING: registry first, then the overlay + marker decorations on top, matching the
// composite draw order and the rebuild sequence deviceRecovery depends on.
const modules: readonly RenderModule[] = [registry, overlay, marker];

// The on-demand display loop: a dirty-flag rAF painter (synchronous in Node). It owns no renderable
// state — it calls back here to paint (plain or GPU-timed), tick the marker easing, and advance the
// settle ramp. paint/paintTimed read the worker's live renderer + paintItems; the loop only decides
// when to call them.
const loop = createRenderLoop({
  hasRenderer: () => renderer !== undefined,
  isDeviceLost: () => recovery.isDeviceLost(),
  paint: () => renderer?.renderComposite(paintItems()),
  paintTimed: () => {
    frameTimer?.beginFrame();
    renderer?.renderComposite(paintItems());
    void sampleAndPostTiming().catch(reportFault);
  },
  paintPerf: () => {
    const startMs = performance.now();
    if (!Number.isNaN(lastPaintMs)) {
      const interval = startMs - lastPaintMs;
      // A long gap means the on-demand loop was idle and just resumed — don't fold it into the EMA.
      frameIntervalEma =
        interval > PERF_IDLE_GAP_MS
          ? Number.NaN
          : Number.isNaN(frameIntervalEma)
            ? interval
            : frameIntervalEma + PERF_EMA_ALPHA * (interval - frameIntervalEma);
    }
    lastPaintMs = startMs;
    // The cheap CPU-encode bracket + interval EMA ride every painted frame; throttle only the GPU
    // wall-clock sync, and bracket the timer just for those frames so its measurement stays exact.
    const sampleGpu =
      Number.isNaN(lastGpuSampleMs) || startMs - lastGpuSampleMs >= PERF_GPU_SAMPLE_MS;
    if (sampleGpu) frameTimer?.beginFrame();
    renderer?.renderComposite(paintItems());
    if (sampleGpu) {
      lastGpuSampleMs = startMs;
      void samplePerf(performance.now() - startMs, frameIntervalEma).catch(reportFault);
    }
  },
  tickAnimations: (frameTimeMs) => marker.tick(frameTimeMs),
  advanceQuality: () => quality.advanceSettling(),
  sampleFrameInterval: (intervalMs) => quality.sampleFrameInterval(intervalMs),
  reportFault,
  clearError: () => {
    lastErrorMessage = undefined;
  },
});

// requestRender forwards to the loop's dirty-flag entry point — a hoisted seam so every manager host
// and message handler can reference it before `loop` is constructed.
function requestRender(): void {
  loop.requestRender();
}

// GPU device-loss recovery: the loss policy + the isDeviceLost flag the loop pauses on + the rebuild
// order. The worker owns the GPU resources the rebuild touches (renderer, frameTimer, testScene,
// cameras), exposed here as cohesive capabilities; the manager sequences them on a restore.
const recovery = createDeviceRecovery({
  hasCanvas: () => canvas !== undefined,
  supersedeInFlightWarms: () => {
    // Any in-flight warm raced the loss: bump every epoch so its commit discards (a superseded
    // streamed field heals on the next step) instead of landing a dead-device scene post-rebuild.
    for (const renderModule of modules) renderModule.supersedeWarms();
  },
  teardownDeadResources: () => {
    // Drop the dead-device resources best-effort: disposing GPU handles on a lost device can throw,
    // and the fresh renderer below is what matters.
    try {
      renderer?.dispose();
      for (const renderModule of modules) renderModule.disposeForRebuild();
      testScene?.dispose();
    } catch {
      // a lost device throws on teardown — ignore; we're replacing everything anyway
    }
    // Outside the try so it runs even if a dead-device scene dispose threw above (registry-only).
    registry.clearPendingDispose();
  },
  rebuildOnDevice: async (device) => {
    if (canvas === undefined) return; // the manager guards hasCanvas() first; this narrows for TS
    resetLedger(); // dead-device disposes may have thrown before releaseAlloc — start the ledger clean
    renderer = await installRenderer({
      canvas,
      width: dims.width,
      height: dims.height,
      devicePixelRatio,
      device,
    });
    frameTimer = createFrameTimer(device);
    if (isDebugScene) testScene = createTestScene();
    applyVolumePose();
    // Replay every module from its retained source on the fresh device (their GPU resources belonged
    // to the dead device); the marker re-seeds the live pose + state internally. Order = modules order.
    for (const renderModule of modules) renderModule.rebuild();
    quality.resyncAfterRebuild();
  },
  warmComposite: async () => {
    // Warm the rebuilt composite on the fresh device before un-pausing the loop, so the first
    // restored frame neither stalls nor draws half-compiled.
    try {
      await renderer?.compileComposite(paintItems());
    } catch (error) {
      reportFault(error);
    }
  },
  requestRender,
  stopLoop: () => loop.stop(),
  reportError,
  reportFault,
  postRecoveryFailed: (reason, message) =>
    ctx.postMessage({ kind: "gpuRecoveryFailed", requestId: -1, reason, message }),
});

function aspect(): number {
  return dims.height > 0 ? dims.width / dims.height : 1;
}

// The pose drives BOTH volume cameras (cheap — keeps the inactive one fresh so a projection flip
// never shows a stale frustum); compositeItems picks the active one by `projection`.
function applyVolumePose(): void {
  rig?.apply(pose, aspect());
  marker.applyPose(); // zoom scale + handle gating track the live pose
}

function volumeCamera(): PerspectiveCamera | OrthographicCamera | undefined {
  return rig?.volumeCamera(projection === "orthographic");
}

async function init(request: Extract<RenderWorkerRequest, { kind: "init" }>): Promise<void> {
  // high-performance picks the discrete GPU on hybrid machines (no-op on a single-GPU phone/tablet);
  // a volume raymarcher wants the fast adapter. installGpu retains the option for device recovery too.
  await installGpu({ powerPreference: "high-performance" });
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
  rig = createCameraRig(aspect());
  applyVolumePose();
  isDebugScene = request.debugScene === true;
  if (isDebugScene) testScene = createTestScene();
  // Subscribe to gpu/'s loss + restore signals: a recoverable loss pauses the loop and rebuilds the
  // renderer + scenes on the re-acquired device; a terminal loss halts and surfaces a reload state.
  recovery.start();
  // Paint the boot frame synchronously (the loop isn't started yet) so "first frame" honestly
  // means a frame is on the swapchain before `ready` fires — the perf-gate contract. With no layers
  // yet that frame is the bare clear color, which matches the page background — a seamless boot.
  requestRender();
  ctx.postMessage({ kind: "ready", requestId: request.requestId });
  loop.start();
}

// The visible layers in draw order, each paired with the camera its projection needs (perspective
// for volumes, orthographic for slices). `layerOverride` swaps in (or appends, when the composite
// doesn't list the id yet — the boot upsert precedes setComposite) a not-yet-committed scene, and
// `overlayOverride` a not-yet-committed overlay (null = none), so a warm can compile the
// *prospective* composite's pipelines before its commit makes it paintable.
function compositeItems(
  layerOverride?: { readonly id: string; readonly entry: LayerEntry },
  overlayOverride?: SceneOverlay | null,
  markerOverride?: MarkerScene | null,
): CompositeItem[] {
  const volume = volumeCamera();
  const ortho = rig?.orthoCamera;
  if (volume === undefined || ortho === undefined) {
    throw new Error("render before init");
  }
  const items = registry.layerItems(volume, ortho, layerOverride);
  // The overlay + marker composite last (on top), paired with the SAME pose-driven camera as the
  // volumes (else they'd misalign under an ortho volume) — and only when a volume layer is present.
  // 3D chrome over a flat ortho slice or an empty frame is meaningless; a volume whose upsert hasn't
  // landed yet heals on its upsert repaint.
  const hasVolume = items.some((item) => item.camera === volume);
  const effectiveOverlay =
    overlayOverride === undefined ? overlay.current() : (overlayOverride ?? undefined);
  if (effectiveOverlay !== undefined && hasVolume) {
    items.push({ scene: effectiveOverlay.scene, camera: volume });
  }
  const effectiveMarker =
    markerOverride === undefined ? marker.current() : (markerOverride ?? undefined);
  if (effectiveMarker !== undefined && hasVolume) {
    items.push({ scene: effectiveMarker.scene, camera: volume });
  }
  return items;
}

// What the next paint draws: the composited layers, the opt-in debug triangle when empty, else
// nothing — renderComposite([]) presents the bare clear color, the flash-free boot/empty frame.
function paintItems(): CompositeItem[] {
  const ortho = rig?.orthoCamera;
  if (ortho === undefined) {
    throw new Error("render before init");
  }
  const items = compositeItems();
  if (items.length === 0 && testScene !== undefined) {
    return [{ scene: testScene.scene, camera: ortho }];
  }
  return items;
}

// Read the just-submitted frame's GPU time and post it. Fire-and-forget off the loop: the read is
// async (and NaNs for in-flight / bad samples the timer rejects) — skip those rather than back up
// the loop. The timer guarantees a valid ms or NaN, so no plausibility filter is needed here.
async function sampleAndPostTiming(): Promise<void> {
  if (frameTimer === undefined) return;
  const gpuTimeMs = await frameTimer.sampleAfterSubmit();
  if (Number.isNaN(gpuTimeMs)) return;
  ctx.postMessage({ kind: "frameTiming", gpuTimeMs, clock: frameTimer.mode });
  // HUD open alongside continuous measurement: it reads the same wall-clock. CPU-encode + interval
  // aren't measured on the continuous path, so they ride as NaN (the HUD renders them blank).
  if (perfActive) postPerfSample(Number.NaN, gpuTimeMs, Number.NaN, true);
}

// Post one perf-HUD sample. vram + heap are read here (both cheap); timing fields are supplied by the
// caller — they differ between the on-demand perf path and the continuous diagnostics path.
function postPerfSample(
  cpuEncodeMs: number,
  frameWallMs: number,
  frameIntervalMs: number,
  isContinuous: boolean,
): void {
  const vram = vramSnapshot();
  ctx.postMessage({
    kind: "perfSample",
    cpuEncodeMs,
    frameWallMs,
    frameIntervalMs,
    isContinuous,
    governorScale: quality.governorScale(),
    vramBytes: vram.totalBytes,
    vramByKey: vram.byKey.slice(0, VRAM_TOP_N), // tiny: structured-cloned, not transferred
    workerHeapBytes: readHeapBytes(),
  });
}

// The on-demand perf path's GPU sample: await the throttled wall-clock (NaN if the timer is absent or
// a read is already in flight — the HUD's rolling mean skips those) and post with the frame's CPU
// encode + interval.
async function samplePerf(cpuEncodeMs: number, frameIntervalMs: number): Promise<void> {
  const frameWallMs = frameTimer === undefined ? Number.NaN : await frameTimer.sampleAfterSubmit();
  postPerfSample(cpuEncodeMs, frameWallMs, frameIntervalMs, false);
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
  loop.beginReadback();
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
    loop.endReadback(); // re-dirty so the swapchain the readback borrowed repaints
  }
}

// Build or rebuild one layer's scene from a transferred field (main → render). The decode + source
// assembly + warm-then-commit live in the layer registry; this gates on init and delegates.
async function upsertLayer(
  request: Extract<RenderWorkerRequest, { kind: "upsertLayer" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("upsertLayer before init");
  }
  await registry.upsert(request);
}

async function removeLayer(
  request: Extract<RenderWorkerRequest, { kind: "removeLayer" }>,
): Promise<void> {
  await initDone;
  registry.remove(request.id);
}

// Cheap reorder/visibility/opacity over the full ordered list — retune per-layer opacity uniforms
// (no rebuild) and repaint. Field data rides the heavier upsertLayer.
async function setComposite(
  request: Extract<RenderWorkerRequest, { kind: "setComposite" }>,
): Promise<void> {
  await initDone;
  registry.setComposite(request.order);
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
  registry.setColormap(request);
}

// Camera-motion liveness → quality tier (the controller owns the transition, level apply, and the
// settle kick; see createQualityController).
async function setCameraMotion(
  request: Extract<RenderWorkerRequest, { kind: "setCameraMotion" }>,
): Promise<void> {
  await initDone;
  cameraMotion = request.motion;
  syncQualityMotion();
}

// Live per-layer Phong toggle — a uniform flip on the volume scene, no rebuild/re-upload. Slice
// layers have no shading normal, so the message is inert for them.
async function setLayerShading(
  request: Extract<RenderWorkerRequest, { kind: "setLayerShading" }>,
): Promise<void> {
  await initDone;
  registry.setShading(request);
}

// Live camera pose: re-aim the perspective camera and repaint. Always repaints — a volume-only
// guard here silently drops the frame during composite-build races and visibility toggles, leaving
// the 3D view stale while the (independently store-driven) gnomon keeps turning. Slices stay
// pose-invariant via the ortho camera, so an unconditional repaint just re-presents them.
async function setCameraPose(
  request: Extract<RenderWorkerRequest, { kind: "setCameraPose" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined || rig === undefined) {
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
  registry.applyProjection(projection === "orthographic");
  requestRender();
}

// Viewport resize: re-size the swapchain + readback targets, fix the perspective aspect, repaint.
async function resize(request: Extract<RenderWorkerRequest, { kind: "resize" }>): Promise<void> {
  await initDone;
  if (renderer === undefined || rig === undefined) {
    throw new Error("resize before init");
  }
  dims = { width: request.width, height: request.height };
  devicePixelRatio = request.devicePixelRatio;
  renderer.setSize(request.width, request.height, request.devicePixelRatio);
  applyVolumePose(); // re-applies both cameras' aspect
  requestRender();
}

// Toggle sustained every-frame measurement. Kicks the loop on enable; the rAF loop carries it from
// there. Inert in Node (no loop) — continuous timing is a browser concern.
async function setContinuous(
  request: Extract<RenderWorkerRequest, { kind: "setContinuous" }>,
): Promise<void> {
  await initDone;
  loop.setContinuous(request.continuous);
}

// Dev perf HUD: gate the worker's per-frame sampling. Resets the interval EMA + GPU throttle on
// enable so a re-open neither folds the idle gap nor fires the GPU sync on the stale clock. Unlike
// setContinuous it doesn't kick the loop — sampling rides frames painting for other reasons.
async function setPerfActive(
  request: Extract<RenderWorkerRequest, { kind: "setPerfActive" }>,
): Promise<void> {
  await initDone;
  perfActive = request.active;
  loop.setPerfActive(request.active);
  if (request.active) {
    lastPaintMs = Number.NaN;
    frameIntervalEma = Number.NaN;
    lastGpuSampleMs = Number.NaN;
  }
}

async function setSceneOverlay(
  request: Extract<RenderWorkerRequest, { kind: "setSceneOverlay" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("setSceneOverlay before init");
  }
  await overlay.build(request.overlay);
}

async function setMarker(
  request: Extract<RenderWorkerRequest, { kind: "setMarker" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("setMarker before init");
  }
  await marker.build(request.marker);
}

// Live marker position + interaction state (high-frequency during a drag): the manager moves the
// marker, retains the state for a device-restore rebuild, and repaints.
async function setPickerPoint(
  request: Extract<RenderWorkerRequest, { kind: "setPickerPoint" }>,
): Promise<void> {
  await initDone;
  marker.setPoint(request.point, request.hovered, request.active);
  // Active edges only (the position rides every move) — drive the shared quality tier so a marker
  // drag coarsens the volume like a camera gesture; the merge keeps a concurrent fly/orbit live.
  if (request.active !== isPickerActive) {
    isPickerActive = request.active;
    syncQualityMotion();
  }
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
  const { layers: pickLayers, halfExtent } = registry.pickLayers();
  const point = pickPointOnRay(
    [near.x, near.y, near.z],
    [dir.x, dir.y, dir.z],
    pickLayers,
    halfExtent,
  );
  ctx.postMessage({
    kind: "pickResult",
    requestId: request.requestId,
    point,
    purpose: request.purpose,
    // exactOptionalPropertyTypes: echo the field only when the request carried it.
    ...(request.focusDistance !== undefined ? { focusDistance: request.focusDistance } : {}),
  });
}

// Pair with the data worker's streaming port. Assigning onmessage implicitly starts the
// port, so streamStep messages posted before this pairing drain here in order — no lost frames.
async function pair(request: Extract<RenderWorkerRequest, { kind: "pair" }>): Promise<void> {
  await initDone;
  streamPort?.close();
  streamPort = request.port;
  streamPort.onmessage = (event: MessageEvent<StreamStepMessage>) => {
    try {
      registry.swapField(event.data);
    } catch (error) {
      reportFault(error);
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
    case "setPerfActive":
      return setPerfActive(request);
    case "setCameraMotion":
      return setCameraMotion(request);
    case "setSceneOverlay":
      return setSceneOverlay(request);
    case "setMarker":
      return setMarker(request);
    case "setPickerPoint":
      return setPickerPoint(request);
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
