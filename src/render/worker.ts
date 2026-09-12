import { readHeapBytes } from "@containers/perf_probe.ts";
import type { StreamStepMessage } from "@data";
import {
  getCapabilities,
  getDevice,
  type InstalledGpu,
  installGpu,
  resetLedger,
  vramSnapshot,
} from "@gpu";
import { errorMessage } from "@schema/log.ts";
import type { OrthographicCamera, PerspectiveCamera } from "three";
import { DEFAULT_POSE } from "./camera/camera.ts";
import { type CameraRig, createCameraRig } from "./camera/cameraRig.ts";
import { createDebugTriangle, type DebugTriangle } from "./debugTriangle.ts";
import { createLayerRegistry } from "./layer/registry.ts";
import { createManagedMarker } from "./marker/managedMarker.ts";
import type {
  CameraMotion,
  CameraPose,
  CameraProjection,
  RenderWorkerRequest,
  RenderWorkerResponse,
} from "./messages.ts";
import { createManagedOverlay } from "./overlay/managedOverlay.ts";
import { pickPointOnRay } from "./pickRay.ts";
import type { RenderModule } from "./renderModule.ts";
import { unprojectRay } from "./runtime/cameraRay.ts";
import { createDeviceRecovery } from "./runtime/deviceRecovery.ts";
import { createDrawList } from "./runtime/drawList.ts";
import { createFrameTimer, type FrameTimer } from "./runtime/frameTimer.ts";
import { createPerfSampler } from "./runtime/perfSampler.ts";
import { createQualityController } from "./runtime/qualityController.ts";
import { createReadback } from "./runtime/readback.ts";
import { type InstalledRenderer, installRenderer } from "./runtime/renderer.ts";
import { createRenderLoop } from "./runtime/renderLoop.ts";

// The dedicated-worker surface the world posts through (`self`, narrowed at the module tail).
interface WorkerContext {
  onmessage: ((event: MessageEvent<RenderWorkerRequest>) => void) | null;
  postMessage(message: RenderWorkerResponse, transfer?: Transferable[]): void;
}

type Request<K extends RenderWorkerRequest["kind"]> = Extract<RenderWorkerRequest, { kind: K }>;

// Everything the render worker owns — GPU handles, cameras, the managed subsystems and the message
// handlers over them — built once per worker so no state lives at module scope.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: the body is the worker's state
function createWorkerWorld(context: WorkerContext): {
  handle(request: RenderWorkerRequest): Promise<void>;
} {
  let gpu: InstalledGpu | undefined; // retained so dispose() can release the device
  let renderer: InstalledRenderer | undefined;
  // The RGB test triangle as the empty frame is opt-in (`?debugScene`, the parity test): a handy
  // "renderer alive, data missing" diagnostic, but a disorienting flash as the default boot frame.
  let isDebugScene = false;
  let testScene: DebugTriangle | undefined;
  let rig: CameraRig | undefined; // survives a device loss: pure JS matrices, no GPU resources
  let projection: CameraProjection = "perspective";
  let pose: CameraPose = DEFAULT_POSE;
  let canvasSize = { width: 0, height: 0 };
  let canvas: OffscreenCanvas | undefined; // retained to rebuild the renderer on device-restore
  let devicePixelRatio = 1; // retained for the rebuild's drawing-buffer scale
  let hasFloat32Filterable = false; // R32F linear volume texture when the device supports it
  // The init promise; every other message waits behind it so none can race a half-built renderer,
  // even for a caller that does not gate on the `ready` response.
  let initDone: Promise<void> | undefined;
  let frameTimer: FrameTimer | undefined; // per-frame GPU timing (wall-clock bracket)
  let lastErrorMessage: string | undefined; // dedupe so a persistent bad frame can't flood the channel
  let streamPort: MessagePort | undefined; // the data worker's streaming end (pair); closed on dispose
  // Two interaction-liveness sources feed the one quality tier: camera motion, and a live marker
  // manipulation (a drag or held-arrow slide re-marches the whole volume per frame, so it must coarsen
  // like an orbit). OR-merged so a hand gesture on either dominates a machine fly, and releasing one
  // source never settles while the other is still live.
  let cameraMotion: CameraMotion = "idle";
  let isPickerActive = false;

  // Surface a worker-side fault without flooding: identical consecutive messages post once.
  function reportError(message: string): void {
    if (message === lastErrorMessage) return;
    lastErrorMessage = message;
    context.postMessage({ kind: "error", requestId: -1, message });
  }

  function reportFault(error: unknown): void {
    reportError(errorMessage(error));
  }

  // Hoisted so every manager host can reference the loop's dirty-flag entry before `loop` exists.
  function requestRender(): void {
    loop.requestRender();
  }

  // Post-dispose (or before any init) the renderer is gone: a message must fail loudly, never no-op.
  function liveRenderer(kind: RenderWorkerRequest["kind"]): InstalledRenderer {
    if (renderer === undefined) throw new Error(`${kind} before init`);
    return renderer;
  }

  function aspect(): number {
    return canvasSize.height > 0 ? canvasSize.width / canvasSize.height : 1;
  }

  // The pose drives BOTH volume cameras (cheap — keeps the inactive one fresh so a projection flip
  // never shows a stale frustum); the composite picks the active one by `projection`.
  function applyVolumePose(): void {
    rig?.apply(pose, aspect());
    marker.applyPose(); // zoom scale + handle gating track the live pose
  }

  function volumeCamera(): PerspectiveCamera | OrthographicCamera | undefined {
    return rig?.volumeCamera(projection === "orthographic");
  }

  function syncQualityMotion(): void {
    const motion: CameraMotion =
      cameraMotion === "gesture" || isPickerActive
        ? "gesture"
        : cameraMotion === "fly"
          ? "fly"
          : "idle";
    quality.setMotion(motion);
  }

  function paint(): void {
    renderer?.renderComposite(composite.scratchPaintItems());
  }

  const quality = createQualityController({
    hasLoop: () => loop.isRunning(),
    applyStepScale: (stepScale) => registry.applyStepScale(stepScale),
    setRenderScale: (scale) => renderer?.setRenderScale(scale),
    requestRender,
  });

  // Every warm compiles the FULL prospective composite — overlay + marker included — through the
  // assembler, so the first paint after a commit never hitches on a sync pipeline compile.
  const registry = createLayerRegistry({
    hasFloat32Filterable: () => hasFloat32Filterable,
    stepScale: () => quality.stepScale(),
    isOrthographic: () => projection === "orthographic",
    requestRender,
    reportFault,
    warmComposite: ({ id, entry }) =>
      renderer?.compileComposite(composite.drawItems({ id, entry })),
  });

  const overlay = createManagedOverlay({
    requestRender,
    reportFault,
    warmComposite: (scene) => renderer?.compileComposite(composite.drawItems(undefined, scene)),
  });

  const marker = createManagedMarker({
    pose: () => pose,
    isOrthographic: () => projection === "orthographic",
    requestRender,
    reportFault,
    warmComposite: (scene) =>
      renderer?.compileComposite(composite.drawItems(undefined, undefined, scene)),
  });

  // Device-restore and dispose() iterate this instead of naming each manager. ORDER IS LOAD-BEARING:
  // registry first, then the overlay + marker decorations on top — the composite draw order and the
  // rebuild sequence deviceRecovery depends on.
  const modules: readonly RenderModule[] = [registry, overlay, marker];

  const composite = createDrawList({
    layerItems: (volume, ortho, override, into) =>
      registry.layerItems(volume, ortho, override, into),
    overlay: () => overlay.current(),
    marker: () => marker.current(),
    volumeCamera,
    orthoCamera: () => rig?.orthoCamera,
    testScene: () => testScene,
  });

  const sampler = createPerfSampler({
    frameTimer: () => frameTimer,
    governorScale: () => quality.governorScale(),
    vramSnapshot,
    readHeapBytes,
    post: (message) => context.postMessage(message),
    reportFault,
  });

  const readback = createReadback({
    renderer: () => renderer,
    paintItems: () => composite.paintItems(),
    beginReadback: () => loop.beginReadback(),
    endReadback: () => loop.endReadback(),
    post: (message, transfer) => context.postMessage(message, transfer),
  });

  const loop = createRenderLoop({
    hasRenderer: () => renderer !== undefined,
    isDeviceLost: () => recovery.isDeviceLost(),
    paint,
    paintTimed: () => sampler.paintTimed(paint),
    paintPerf: () => sampler.paintPerf(paint),
    tickAnimations: (frameTimeMs) => marker.tick(frameTimeMs),
    advanceQuality: () => quality.advanceSettling(),
    sampleFrameInterval: (intervalMs) => quality.sampleFrameInterval(intervalMs),
    reportFault,
    clearError: () => {
      lastErrorMessage = undefined;
    },
  });

  // The GPU resources a device-loss rebuild touches (renderer, frameTimer, testScene, cameras) live
  // here, exposed as cohesive capabilities; deviceRecovery sequences them on a restore.
  const recovery = createDeviceRecovery({
    hasCanvas: () => canvas !== undefined,
    supersedeInFlightWarms: () => {
      // Any in-flight warm raced the loss: bump every epoch so its commit discards (a superseded
      // streamed field heals on the next step) instead of landing a dead-device scene post-rebuild.
      for (const renderModule of modules) renderModule.supersedeWarms();
    },
    teardownDeadResources: () => {
      try {
        renderer?.dispose();
        for (const renderModule of modules) renderModule.disposeForRebuild();
        testScene?.dispose();
      } catch {
        // a lost device throws on teardown — ignore; the fresh renderer below is what matters
      }
      registry.clearPendingDispose(); // outside the try: runs even if a dead-device dispose threw
    },
    rebuildOnDevice: async (device) => {
      if (canvas === undefined) return; // the manager guards hasCanvas() first; this narrows for TS
      resetLedger(); // dead-device disposes may have thrown before releaseAlloc — start the ledger clean
      renderer = await installRenderer({
        canvas,
        width: canvasSize.width,
        height: canvasSize.height,
        devicePixelRatio,
        device,
      });
      frameTimer = createFrameTimer(device);
      if (isDebugScene) testScene = createDebugTriangle();
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
        await renderer?.compileComposite(composite.paintItems());
      } catch (error) {
        reportFault(error);
      }
    },
    requestRender,
    stopLoop: () => loop.stop(),
    reportError,
    reportFault,
    postRecoveryFailed: (reason, message) =>
      context.postMessage({ kind: "gpuRecoveryFailed", requestId: -1, reason, message }),
  });

  async function init(request: Request<"init">): Promise<void> {
    // high-performance picks the discrete GPU on hybrid machines — a volume raymarcher wants the fast
    // adapter; installGpu retains the option for device recovery too.
    gpu = await installGpu({ powerPreference: "high-performance" });
    canvas = request.canvas;
    devicePixelRatio = request.devicePixelRatio;
    renderer = await installRenderer({
      canvas: request.canvas,
      width: request.width,
      height: request.height,
      devicePixelRatio,
      device: getDevice(),
    });
    canvasSize = { width: request.width, height: request.height };
    hasFloat32Filterable = getCapabilities().hasFloat32Filterable;
    frameTimer = createFrameTimer(getDevice());
    rig = createCameraRig(aspect());
    applyVolumePose();
    isDebugScene = request.showDebugScene === true;
    if (isDebugScene) testScene = createDebugTriangle();
    recovery.start(); // gpu/'s loss + restore signals: pause + rebuild, or halt + surface a reload state
    // Paint the boot frame synchronously (the loop isn't started yet) so "first frame" honestly means
    // a frame is on the swapchain before `ready` fires — the perf-gate contract. With no layers yet
    // that frame is the bare clear color, matching the page background: a seamless boot.
    requestRender();
    context.postMessage({ kind: "ready", requestId: request.requestId });
    loop.start();
  }

  // Build or rebuild one layer from transferred data through the registry's warm-then-commit. Whether
  // the warm completes, errors, or is superseded, the first paint won't hitch on a sync compile — so
  // main always hears layerCompiled and drops the layer's loading pill.
  async function compileLayer(
    request: Request<"upsertLayer" | "upsertFieldlines">,
    build: () => Promise<void>,
  ): Promise<void> {
    liveRenderer(request.kind);
    try {
      await build();
    } finally {
      context.postMessage({ kind: "layerCompiled", requestId: request.requestId, id: request.id });
    }
  }

  // Always repaints — a volume-only guard silently drops the frame during composite-build races and
  // visibility toggles, leaving the 3D view stale while the store-driven gnomon keeps turning. Slices
  // stay pose-invariant via the ortho camera, so the repaint just re-presents them.
  function setCameraPose(request: Request<"setCameraPose">): void {
    liveRenderer(request.kind);
    pose = request.pose;
    applyVolumePose();
    requestRender();
  }

  // Pick the other pose-driven camera and flip every volume scene's ray generation (a uniform, no
  // rebuild). The matched ortho frustum (halfH = d·tan(fov/2)) keeps the on-screen scale at the target
  // plane, so the flip is visually seamless except for parallax.
  function setProjection(request: Request<"setProjection">): void {
    if (projection === request.projection) return;
    projection = request.projection;
    applyVolumePose(); // the incoming camera re-aims at the live pose before it paints
    registry.applyProjection(projection === "orthographic");
    requestRender();
  }

  function resize(request: Request<"resize">): void {
    const live = liveRenderer(request.kind);
    canvasSize = { width: request.width, height: request.height };
    devicePixelRatio = request.devicePixelRatio;
    live.setSize(request.width, request.height, request.devicePixelRatio);
    applyVolumePose(); // re-applies both cameras' aspect
    requestRender();
  }

  function setPickerPoint(request: Request<"setPickerPoint">): void {
    marker.setPoint(request.point, request.hovered, request.active);
    // Active edges only (the position rides every move) drive the shared quality tier, so a marker
    // drag coarsens the volume like a camera gesture; the merge keeps a concurrent fly/orbit live.
    if (request.active !== isPickerActive) {
      isPickerActive = request.active;
      syncQualityMotion();
    }
  }

  // Pick-to-focus: march the cursor ray through the retained CPU fields (no GPU round-trip), the ray
  // taken from the live volume camera so it matches the frame this click saw (postMessage ordering).
  function pickRay(request: Request<"pickRay">): void {
    const camera = volumeCamera();
    if (camera === undefined) throw new Error("pickRay before init");
    const { origin, dir } = unprojectRay(camera, request.ndcX, request.ndcY);
    const { layers: pickLayers, halfExtent } = registry.pickLayers();
    const point = pickPointOnRay(origin, dir, pickLayers, halfExtent);
    context.postMessage({
      kind: "pickResult",
      requestId: request.requestId,
      point,
      purpose: request.purpose,
      // exactOptionalPropertyTypes: echo the field only when the request carried it.
      ...(request.focusDistance !== undefined ? { focusDistance: request.focusDistance } : {}),
    });
  }

  // Assigning onmessage implicitly starts the port, so streamStep messages posted before this pairing
  // drain here in order — no lost frames.
  function pair(request: Request<"pair">): void {
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

  // Dev-only shader hot-reload: re-import the scene factory fresh (cache-busted by `timestamp`) and
  // swap every volume layer's material in place — texture, uniforms and pose carry over (no 64 MiB
  // re-upload). Re-warm off the render path, then repaint; a bad edit is reported and leaves the prior
  // shader rendering. Gated on import.meta.env.DEV so prod tree-shakes this branch + shaderReload.
  async function rebuildShader(request: Request<"rebuildShader">): Promise<void> {
    if (renderer === undefined) return;
    if (!import.meta.env.DEV) return; // prod: dead branch → shaderReload never enters the bundle
    try {
      const { loadFreshRaymarchBuilder } = await import("./field/shaderReload.ts");
      registry.rebuildShaders(await loadFreshRaymarchBuilder(request.timestamp));
      await renderer.compileComposite(composite.paintItems());
    } catch (error) {
      reportFault(error);
    }
    requestRender();
  }

  // Orderly teardown ahead of main's terminate(). Recovery stops before the device goes — its
  // intentional-loss signal must not trigger a rebuild; a pending init is awaited so a half-built
  // renderer is never torn down mid-construction.
  async function dispose(request: Request<"dispose">): Promise<void> {
    try {
      await initDone;
    } catch {
      // init already reported its own error — release whatever did get built
    }
    loop.stop();
    recovery.stop();
    streamPort?.close();
    streamPort = undefined;
    for (const renderModule of modules) renderModule.dispose();
    testScene?.dispose();
    testScene = undefined;
    renderer?.dispose();
    renderer = undefined;
    frameTimer = undefined;
    gpu?.dispose();
    gpu = undefined;
    context.postMessage({ kind: "disposed", requestId: request.requestId });
  }

  async function handle(request: RenderWorkerRequest): Promise<void> {
    // init builds the gate and dispose awaits it leniently itself; everything else waits behind it.
    if (request.kind !== "init" && request.kind !== "dispose") await initDone;
    switch (request.kind) {
      case "init":
        initDone = init(request);
        return initDone;
      case "renderFrame":
        return readback.frame(request);
      case "screenshot":
        return readback.screenshot(request);
      case "upsertLayer":
        return compileLayer(request, () => registry.upsert(request));
      case "upsertFieldlines":
        return compileLayer(request, () => registry.upsertFieldlines(request));
      case "removeLayer":
        return registry.remove(request.id);
      case "setLayerOrder":
        return registry.setLayerOrder(request.order);
      case "setLayerColormap":
        liveRenderer(request.kind);
        return registry.setColormap(request);
      case "setLayerShading":
        return registry.setShading(request);
      case "setSliceParams":
        return registry.setSliceParams(request);
      case "setCameraPose":
        return setCameraPose(request);
      case "setProjection":
        return setProjection(request);
      case "resize":
        return resize(request);
      case "setContinuous":
        return loop.setContinuous(request.continuous);
      case "setPerfActive":
        sampler.setActive(request.active);
        return loop.setPerfActive(request.active);
      case "setCameraMotion":
        cameraMotion = request.motion;
        return syncQualityMotion();
      case "setSceneOverlay":
        liveRenderer(request.kind);
        return overlay.build(request.overlay);
      case "setMarker":
        liveRenderer(request.kind);
        return marker.build(request.marker);
      case "setPickerPoint":
        return setPickerPoint(request);
      case "pickRay":
        return pickRay(request);
      case "pair":
        return pair(request);
      case "rebuildShader":
        return rebuildShader(request);
      case "dispose":
        return dispose(request);
      default: {
        const unreachable: never = request;
        throw new Error(`unknown request: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  return { handle };
}

// Worker-scope view of `self`. This module stays under the DOM-lib program (its node suites import
// it), where `self` is a Window whose postMessage wants a targetOrigin — so narrow it to the
// dedicated-worker surface.
const context = self as unknown as WorkerContext;
const world = createWorkerWorld(context);
context.onmessage = (event) => {
  const request = event.data;
  world.handle(request).catch((error: unknown) => {
    context.postMessage({
      kind: "error",
      requestId: request.requestId,
      message: errorMessage(error),
    });
  });
};
