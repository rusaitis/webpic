import type { StreamStepMessage } from "@data";
import { getCapabilities, getDevice, installGpu, onDeviceLost, onDeviceRestored } from "@gpu";
import type { Vec3 } from "@schema/types.ts";
import { type OrthographicCamera, type PerspectiveCamera, Vector3 } from "three";
import { DEFAULT_POSE } from "./camera.ts";
import { type CameraRig, createCameraRig } from "./cameraRig.ts";
import { createFrameTimer, type FrameTimer } from "./frameTimer.ts";
import { createSceneOverlay, type SceneOverlay } from "./grid/overlayScene.ts";
import {
  advanceSettling,
  applyCameraMotion,
  QUALITY_FULL,
  type QualityLevel,
  type QualityState,
  qualityLevel,
} from "./interactionQuality.ts";
import { createLayerRegistry, type LayerEntry } from "./layerRegistry.ts";
import { warmScene } from "./managedScene.ts";
import { createMarkerScene, type MarkerScene } from "./marker/markerScene.ts";
import type {
  CameraPose,
  CameraProjection,
  MarkerConfig,
  MarkerPart,
  RenderWorkerRequest,
  RenderWorkerResponse,
  SceneOverlayConfig,
} from "./messages.ts";
import { pickPointOnRay } from "./pickRay.ts";
import { type CompositeItem, type InstalledRenderer, installRenderer } from "./renderer.ts";
import { createTestScene, type TestScene } from "./scene.ts";

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
// The worker's cameras (cameraRig): the pose-driven volume pair + the screen-aligned ortho for slices
// + boot. Created in init; survives a device loss (pure JS matrices, no GPU resources).
let rig: CameraRig | undefined;
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

// The themeable axes + grid overlay (composited last, over the volume) + the config it was built from.
// overlaySource is retained so a device-restore rebuild reproduces the live overlay, mirroring how a
// layer retains its LayerSource. Labels are auto-billboarding Sprites, so no per-pose update is needed.
let overlay: SceneOverlay | undefined;
let overlaySource: SceneOverlayConfig | undefined;

// The draggable point-picker marker (composited last, over the volume + overlay) + its retained build
// config + live position/state, all replayed on a device-restore rebuild. Its hover/pulse/active
// easing is advanced in renderTick (tick()); applyVolumePose re-runs its zoom scale + handle gating.
let marker: MarkerScene | undefined;
let markerSource: MarkerConfig | undefined;
let markerPoint: Vec3 | null = null;
let markerHovered: MarkerPart = "none";
let markerActive = false;
let lastMarkerTickMs: number | undefined; // wall clock of the previous tick, for the easing dt

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

// The renderable layers + their lifecycle (build/replace/remove, composite, color/shading, the
// warm-then-commit, the device-restore replay). It reaches back for live quality/projection + the
// repaint/fault seams, and warms the FULL composite — overlay + marker live here, so the worker
// assembles it via compositeItems.
const registry = createLayerRegistry({
  float32Filterable: () => float32Filterable,
  stepScale: () => qualityLevel(quality).stepScale,
  isOrthographic: () => projection === "orthographic",
  requestRender,
  reportFault,
  warmComposite: ({ id, entry }) => renderer?.compileComposite(compositeItems({ id, entry })),
});

function aspect(): number {
  return dims.height > 0 ? dims.width / dims.height : 1;
}

// The pose drives BOTH volume cameras (cheap — keeps the inactive one fresh so a projection flip
// never shows a stale frustum); compositeItems picks the active one by `projection`.
function applyVolumePose(): void {
  rig?.apply(pose, aspect());
  marker?.updateForPose(pose, projection === "orthographic"); // zoom scale + handle gating track the pose
}

function volumeCamera(): PerspectiveCamera | OrthographicCamera | undefined {
  return rig?.volumeCamera(projection === "orthographic");
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
  rig = createCameraRig(aspect());
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
    void rebuildOnDevice(device).catch(reportFault);
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
  const effectiveOverlay = overlayOverride === undefined ? overlay : (overlayOverride ?? undefined);
  if (effectiveOverlay !== undefined && hasVolume) {
    items.push({ scene: effectiveOverlay.scene, camera: volume });
  }
  const effectiveMarker = markerOverride === undefined ? marker : (markerOverride ?? undefined);
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

// The single repaint entry point for message handlers. Sets the dirty flag for the loop; if no loop
// is running (Node, or the init boot paint before startRenderLoop), renders synchronously instead.
function requestRender(): void {
  needsRender = true;
  if (rafId === undefined && renderer !== undefined && !deviceLost) {
    renderer.renderComposite(paintItems());
    needsRender = false;
  }
}

function renderTick(frameTimeMs: number): void {
  // Reschedule first so a throwing frame can't permanently strand the loop.
  rafId = requestAnimationFrame(renderTick);
  if (readbackInFlight || renderer === undefined || deviceLost) return;
  // Advance the marker's hover/pulse/active easing (cheap, alloc-free) and keep painting while it
  // animates. Runs every frame the rAF loop reschedules anyway, so it adds no new loop; it only
  // dirties needsRender while easing, then the on-demand loop falls back to idle. dt comes from the
  // vsync-aligned rAF timestamp, not performance.now() — callback scheduling jitter would unevenly
  // chop the easing steps.
  if (marker !== undefined) {
    const dtSec = lastMarkerTickMs === undefined ? 1 / 60 : (frameTimeMs - lastMarkerTickMs) / 1000;
    lastMarkerTickMs = frameTimeMs;
    if (marker.tick(dtSec)) needsRender = true;
  } else {
    lastMarkerTickMs = undefined;
  }
  // Continuous mode repaints every frame for sustained GPU timing; otherwise paint only on change.
  if (!needsRender && !continuous) return;
  needsRender = false;
  try {
    // GPU timing only while measuring (continuous): its onSubmittedWorkDone bracket is a GPU sync,
    // so on-demand interactive frames skip it entirely and stay smooth.
    if (continuous) {
      frameTimer?.beginFrame();
      renderer.renderComposite(paintItems());
      void sampleAndPostTiming().catch(reportFault);
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
    reportFault(error);
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

// Camera-motion liveness → quality tier: volumes march coarser (uniform flip, no rebuild) AND the
// swapchain renders at a reduced scale while a gesture is live; machine-driven flies keep full
// resolution with a mildly coarser march; the idle edge starts a short settle ramp the display
// loop advances one painted frame at a time, instead of a one-frame pop back to full quality.
// State transitions are pure (interactionQuality.ts).
let quality: QualityState = QUALITY_FULL;
let appliedLevel: QualityLevel = qualityLevel(QUALITY_FULL);

function applyQuality(): void {
  const level = qualityLevel(quality);
  let changed = false;
  if (level.stepScale !== appliedLevel.stepScale) {
    registry.applyStepScale(level.stepScale);
    changed = true;
  }
  if (level.renderScale !== appliedLevel.renderScale) {
    renderer?.setRenderScale(level.renderScale);
    changed = true;
  }
  appliedLevel = level;
  if (changed) requestRender();
}

async function setCameraMotion(
  request: Extract<RenderWorkerRequest, { kind: "setCameraMotion" }>,
): Promise<void> {
  await initDone;
  quality = applyCameraMotion(quality, request.motion);
  // No display loop (Node) means nothing advances a settle ramp — collapse straight to full so
  // the synchronous one-shot paints land at final quality.
  if (rafId === undefined && quality.kind === "settling") quality = QUALITY_FULL;
  applyQuality();
  // animating → settling step 0 is level-identical, so applyQuality posts no repaint — but the
  // ramp only advances after a *painted* frame; without this kick it would stall at 0.7 forever.
  if (quality.kind === "settling") requestRender();
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

// Rebuild the renderer + every scene on the device gpu/ re-acquired after a loss. The old renderer
// and all GPU textures belong to the dead device; the layers' CPU sources survive, so scenes rebuild
// locally with no main↔worker reseed. The loop stays paused (deviceLost) until this completes.
async function rebuildOnDevice(device: GPUDevice): Promise<void> {
  if (canvas === undefined) return; // pre-init loss — nothing to rebuild yet
  // Any in-flight warm raced the loss: bump every epoch so its commit discards (a superseded
  // streamed field heals on the next step) instead of landing a dead-device scene post-rebuild.
  registry.bumpAllEpochs();
  overlayEpoch += 1;
  markerEpoch += 1; // an in-flight buildMarker warm must discard rather than land a dead-device scene
  // Drop the dead-device resources best-effort: disposing GPU handles on a lost device can throw,
  // and the fresh renderer below is what matters.
  try {
    renderer?.dispose();
    registry.disposeForRebuild();
    overlay?.dispose();
    marker?.dispose();
    testScene?.dispose();
  } catch {
    // a lost device throws on teardown — ignore; we're replacing everything anyway
  }
  registry.clearPendingDispose();
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
  registry.rebuildScenes();
  // Replay the overlay from its retained config on the fresh device (its line buffers + CanvasTextures
  // belonged to the dead device). Sprites re-billboard on the next render.
  overlay = overlaySource !== undefined ? createSceneOverlay(overlaySource) : undefined;
  // Same for the marker — rebuild from its retained config and replay the live pose + position/state.
  marker = markerSource !== undefined ? createMarkerScene(markerSource) : undefined;
  if (marker !== undefined) {
    marker.updateForPose(pose, projection === "orthographic");
    marker.setPoint(markerPoint);
    marker.setState(markerHovered, markerActive);
  }
  lastMarkerTickMs = undefined;
  // The fresh renderer starts at scale 1 and the rebuilt scenes already carry the live step scale —
  // resync the applied-level cache, then re-apply in case a gesture is live across the restore.
  appliedLevel = { stepScale: qualityLevel(quality).stepScale, renderScale: 1 };
  applyQuality();
  // Warm the rebuilt composite on the fresh device before un-pausing the loop, so the first
  // restored frame neither stalls nor draws half-compiled.
  try {
    await renderer.compileComposite(paintItems());
  } catch (error) {
    reportFault(error);
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
// like a layer replace — the warm also compiles the volume's pipelines for the ≥2-layer composite
// context this overlay usually activates. New scene live before the old one's GPU resources are
// freed — the overlay has no readback-borrowed texture, so a same-tick dispose is safe (unlike the
// layer registry's one-frame deferral). Retains the source for a device-restore rebuild.
let overlayEpoch = 0;

async function buildOverlay(config: SceneOverlayConfig | null): Promise<void> {
  const epoch = ++overlayEpoch;
  const next = config !== null ? createSceneOverlay(config) : undefined;
  const committed = await warmScene(
    next,
    () => renderer?.compileComposite(compositeItems(undefined, next)),
    () => overlayEpoch === epoch,
    (scene) => scene.dispose(),
    reportFault,
  );
  if (!committed) return;
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

// Build/replace the point-picker marker scene (or tear it down on null) — warm-then-commit like
// buildOverlay, seeding the fresh scene with the live pose + position so the warm compiles the real
// composite and the first committed frame shows the marker in place. Retains the source for a
// device-restore rebuild.
let markerEpoch = 0;

async function buildMarker(config: MarkerConfig | null): Promise<void> {
  const epoch = ++markerEpoch;
  const next = config !== null ? createMarkerScene(config) : undefined;
  // Seed the live pose + position before the warm, so it compiles the real composite and the first
  // committed frame shows the marker in place.
  if (next !== undefined) {
    next.updateForPose(pose, projection === "orthographic");
    next.setPoint(markerPoint);
    next.setState(markerHovered, markerActive);
  }
  const committed = await warmScene(
    next,
    () => renderer?.compileComposite(compositeItems(undefined, undefined, next)),
    () => markerEpoch === epoch,
    (scene) => scene.dispose(),
    reportFault,
  );
  if (!committed) return;
  const previous = marker;
  marker = next;
  markerSource = config ?? undefined;
  previous?.dispose();
  lastMarkerTickMs = undefined; // restart the easing dt clock for the fresh scene
  requestRender();
}

async function setMarker(
  request: Extract<RenderWorkerRequest, { kind: "setMarker" }>,
): Promise<void> {
  await initDone;
  if (renderer === undefined) {
    throw new Error("setMarker before init");
  }
  await buildMarker(request.marker);
}

// Live marker position + interaction state (high-frequency during a drag): move the marker and feed
// its hover/pulse/active easing, retaining both so a device-restore rebuild reproduces the live marker.
async function setPickerPoint(
  request: Extract<RenderWorkerRequest, { kind: "setPickerPoint" }>,
): Promise<void> {
  await initDone;
  markerPoint =
    request.point === null ? null : [request.point[0], request.point[1], request.point[2]];
  markerHovered = request.hovered;
  markerActive = request.active;
  marker?.setPoint(markerPoint);
  marker?.setState(markerHovered, markerActive);
  requestRender();
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

export function dispose(): void {
  unsubscribeGpu?.();
  unsubscribeGpu = undefined;
  streamPort?.close();
  streamPort = undefined;
  stopRenderLoop();
  registry.disposeAll();
  overlay?.dispose();
  overlay = undefined;
  overlaySource = undefined;
  marker?.dispose();
  marker = undefined;
  markerSource = undefined;
  testScene?.dispose();
  renderer?.dispose();
  gpu?.dispose();
}
