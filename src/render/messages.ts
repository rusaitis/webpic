import type { CameraMotion, CameraPose, CameraProjection } from "@schema/camera.ts";
import type { ColorScale, WindowLevel } from "@schema/colormap.ts";
import type { MarkerPart, PickPurpose } from "@schema/marker.ts";
import type { Rgba01 } from "@schema/theme.ts";
import type { Vec3 } from "@schema/types.ts";
import type { SliceAxis } from "./volume/sliceScene.ts";

export type { CameraMotion, CameraPose, CameraProjection, MarkerPart, PickPurpose, WindowLevel };

// Typed protocol for the OffscreenCanvas render worker. Discriminated unions both
// ways; `requestId` correlates a response to its request and pre-stages the
// cancellation plumbing the fuller StoreToRender/RenderToStore protocol will need.
// Transferables (OffscreenCanvas, field/pixel ArrayBuffer) move by transfer, never clone.
//
// requestId convention: it is genuinely *correlated* only for the request/response pairs the worker
// answers — `init`→`ready`, `renderFrame`→`frame`, `pickRay`→`pickResult`. The one-way store→worker
// messages (camera pose, colormap, composite, …) are fire-and-forget, so the hardcoded ids the app
// bridges post are stable labels, not match keys; collisions across those are harmless. Introduce a
// real id allocator only when a new reply must match a specific request (e.g. M2.12's compile-complete).

// A computed scalar field, serialized for transfer to the worker: the typed array can't
// cross `postMessage` as a view, so it goes as a raw `buffer` + a `dtype` tag the worker
// reinterprets (a buffer read as the wrong type silently corrupts the field).
export interface SliceFieldPayload {
  readonly buffer: ArrayBuffer;
  readonly dtype: "f32" | "f64";
  readonly shape: readonly number[];
}

// The renderable kind of a layer (picks the scene factory + the composite camera). The single home
// for the render-side discriminant; the store mirrors it structurally as `Layer["kind"]` (the DAG
// keeps the two layers from importing each other — they agree by validation at the message boundary).
export type LayerKind = "slice" | "volume";

// One field axis's physical extent + sample count + name, for the scene overlay's labeled grid/axes.
// FIELD-axis order (0/1/2 = pypic GridInfo). `bounds` are inclusive [min, max] in code units (the app
// derives them from GridInfo origin/spacing, or falls back to voxel [0, dim]); the worker maps field
// axes → THREE xyz internally (overlayRemap.fieldAxisToThree) and treats the numbers opaquely.
export interface OverlayAxis {
  readonly bounds: readonly [number, number];
  readonly label: string; // GridInfo.axisLabels[axis], e.g. "x" / "r" / "z"
}

// The themeable 3D axes + equatorial grid overlay (composited last, over the volume, perspective
// camera). The app assembles it from the store's overlay flags + the dataset GridInfo + the resolved
// theme palette; the worker rebuilds its scene on receipt. Plane flags are in THREE terms (xy is the
// horizontal/equatorial plane under the z-up camera); axis colors are THREE-axis-indexed so they agree
// with the corner gnomon, while each axis's name + tick labels come from the field axis it maps to.
export interface SceneOverlayConfig {
  readonly axes: readonly [OverlayAxis, OverlayAxis, OverlayAxis];
  readonly planes: { readonly xy: boolean; readonly yz: boolean; readonly xz: boolean };
  readonly planePosition: "center" | "min" | "max"; // where the held (out-of-plane) axis sits
  readonly show: { readonly grid: boolean; readonly axes: boolean; readonly labels: boolean };
  readonly grid: { readonly color: Rgba01; readonly majorOpacity: number };
  readonly axisColors: { readonly x: Rgba01; readonly y: Rgba01; readonly z: Rgba01 };
  readonly labelColor: Rgba01;
  readonly tick: { readonly targetCount: number };
  // Per-axis world half-extent of the volume box the overlay wraps (THREE-axis order, = field-axis
  // order under the identity convention). Default [0.5,0.5,0.5] (unit cube); anisotropic for a
  // non-cubic dataset so the grid/axes share the scaled volume's box. Optional for back-compat.
  readonly worldHalfExtent?: Vec3;
}

// The draggable point-picker marker (sphere + two-tone ring + ↕/↔ handles + drop-line/crosshair).
// Like SceneOverlayConfig this is the low-frequency *build* config (theme colors + the guide plane);
// the geometry/gating constants live in @schema/marker (shared with the main-thread hit-test). The
// live position + hover/active state ride the cheap setPickerPoint message. `guideColor` paints the
// drop line + crosshair; `planePosition` places that guide plane (matching the grid overlay).
export interface MarkerConfig {
  readonly coreColor: Rgba01;
  readonly guideColor: Rgba01;
  readonly planePosition: "center" | "min" | "max";
}

export type RenderWorkerRequest =
  | {
      readonly kind: "init";
      readonly requestId: number;
      readonly canvas: OffscreenCanvas;
      // Logical (CSS) pixel size; the worker scales the drawing buffer by devicePixelRatio. An
      // OffscreenCanvas has no window.devicePixelRatio, so it must ride the wire from the main thread.
      readonly width: number;
      readonly height: number;
      readonly devicePixelRatio: number;
      // Opt into the RGB boot/test triangle as the empty-layers frame (`?debugScene`, parity test).
      // Off by default: the user-facing boot frame is the bare clear color, not a placeholder flash.
      readonly debugScene?: boolean;
    }
  | { readonly kind: "renderFrame"; readonly requestId: number }
  // Viewport changed (window resize / DPR change). Logical size + DPR; the worker re-sizes the
  // swapchain, fixes the perspective aspect, and repaints.
  | {
      readonly kind: "resize";
      readonly requestId: number;
      readonly width: number;
      readonly height: number;
      readonly devicePixelRatio: number;
    }
  // Build or rebuild one layer's scene (instance-first composite). Transfers the field buffer;
  // `layerKind` is the renderable kind (the message `kind` is the discriminant). Kind-specific
  // params are optional — omitted ones fall back to the scene factory defaults.
  | {
      readonly kind: "upsertLayer";
      readonly requestId: number;
      readonly id: string;
      readonly layerKind: LayerKind;
      readonly field: SliceFieldPayload;
      readonly colormap: string;
      readonly scale: ColorScale;
      readonly opacity: number;
      readonly windowLevel?: WindowLevel;
      readonly axis?: SliceAxis;
      readonly position?: number;
      readonly steps?: number;
      readonly density?: number;
      readonly shaded?: boolean; // volume-only Phong toggle
      // Per-axis world half-extent of the volume box; default [0.5,0.5,0.5] (unit cube). Scales the
      // volume mesh to the dataset's physical aspect (non-cubic grids). Volume-only.
      readonly worldHalfExtent?: Vec3;
    }
  | { readonly kind: "removeLayer"; readonly requestId: number; readonly id: string }
  // Cheap reorder/visibility/opacity over the full ordered list — no field transfer.
  | {
      readonly kind: "setComposite";
      readonly requestId: number;
      readonly order: readonly {
        readonly id: string;
        readonly visible: boolean;
        readonly opacity: number;
      }[];
    }
  // Live per-layer color update — colormap + window/level + scale (one layer's ColormapBinding,
  // resolved to the layer it draws). No field buffer, so dragging never re-transfers the volume;
  // the worker keys scenes by layer id, so the wire is layer-addressed (not binding-addressed).
  | {
      readonly kind: "setLayerColormap";
      readonly requestId: number;
      readonly id: string;
      readonly colormap: string;
      readonly windowLevel: WindowLevel;
      readonly scale: ColorScale;
    }
  // Live per-layer Phong toggle (volume-only). A uniform flip — no rebuild, no field re-transfer —
  // so it can't blow the budget on the 64 MiB volume. Ignored by slice layers (they have no normal).
  | {
      readonly kind: "setLayerShading";
      readonly requestId: number;
      readonly id: string;
      readonly shaded: boolean;
    }
  // Camera pose update — high-frequency, delta-only (DESIGN §443); the worker re-applies + repaints.
  | {
      readonly kind: "setCameraPose";
      readonly requestId: number;
      readonly pose: CameraPose;
    }
  // Volume-view projection flip: swap the volume camera (matched frustum — same on-screen scale at
  // the target plane) and flip the raymarch ray generation (a uniform, no rebuild).
  | {
      readonly kind: "setProjection";
      readonly requestId: number;
      readonly projection: CameraProjection;
    }
  // Diagnostics: force sustained every-frame repaints so the GPU timer yields a live stream (the
  // exit-gate workload). Off by default — timing is sampled only while continuous, so on-demand
  // interactive frames skip the per-frame GPU sync.
  | { readonly kind: "setContinuous"; readonly requestId: number; readonly continuous: boolean }
  // Camera-gesture liveness (drag/glide/tween/wheel): volumes march coarser while true (a uniform
  // flip, no rebuild) and the false edge repaints at full quality — interaction-time responsiveness.
  | { readonly kind: "setCameraMotion"; readonly requestId: number; readonly motion: CameraMotion }
  // Themeable 3D axes + equatorial grid overlay. Rebuilds the overlay scene from `overlay`; `null`
  // clears it. Low-frequency (toggles / dataset swaps), so it carries the full config each time.
  | {
      readonly kind: "setSceneOverlay";
      readonly requestId: number;
      readonly overlay: SceneOverlayConfig | null;
    }
  // Build/rebuild the point-picker marker scene from a config, or tear it down on null (toggle off /
  // no volume). Low-frequency (toggle / theme / dataset swap), like setSceneOverlay; the live
  // position rides setPickerPoint below.
  | {
      readonly kind: "setMarker";
      readonly requestId: number;
      readonly marker: MarkerConfig | null;
    }
  // Live marker position + interaction state (high-frequency during a drag). `point` is object space
  // (= world); null hides the marker without tearing down its scene. `hovered`/`active` drive the
  // worker's hover/pulse/active easing.
  | {
      readonly kind: "setPickerPoint";
      readonly requestId: number;
      readonly point: Vec3 | null;
      readonly hovered: MarkerPart;
      readonly active: boolean;
    }
  // Cursor-ray pick (single-click place / double-click focus): march one cursor ray (NDC, dollyAt's
  // convention — x right, y up) through the retained CPU fields and reply with the world point at the
  // median visual depth (pickResult), echoing `purpose` so the app routes the result. The worker
  // already holds the live pose/projection/aspect; postMessage ordering guarantees it has the pose
  // the click saw. `focusDistance` is echoed opaquely like `purpose` — the goal distance computed by
  // ui at gesture time, so the refined-pick retarget can't compound the ×0.7 dolly mid-flight.
  | {
      readonly kind: "pickRay";
      readonly requestId: number;
      readonly ndcX: number;
      readonly ndcY: number;
      readonly purpose: PickPurpose;
      readonly focusDistance?: number;
    }
  // Time-series streaming: the data worker's end of a private MessageChannel. The worker reads +
  // computes each scrubbed step off-main and posts StreamStepMessage (from @data) over this port, so
  // the scalar flows data → render with no main-thread hop. Stored on receipt; the port's own
  // onmessage handles the field swaps.
  | { readonly kind: "pair"; readonly requestId: number; readonly port: MessagePort };

// Why a terminal GPU loss could not be recovered: re-acquisition found no adapter, or the recovery
// circuit-breaker tripped on repeated rapid losses.
export type GpuRecoveryReason = "no-adapter" | "repeated-loss";

export type RenderWorkerResponse =
  | { readonly kind: "ready"; readonly requestId: number }
  | {
      readonly kind: "frame";
      readonly requestId: number;
      readonly width: number;
      readonly height: number;
      readonly pixels: ArrayBuffer; // RGBA8, row-major
    }
  // Per-frame GPU time (DESIGN §444 RenderToStore). `clock` labels the source — timestamp-query is
  // GPU-only; wallclock includes JS/queue latency and must not masquerade as the pure-GPU number.
  | {
      readonly kind: "frameTiming";
      readonly gpuTimeMs: number;
      readonly clock: "timestamp" | "wallclock";
    }
  // Pick reply: the world-space point (unit box has identity transform, so world = object space), or
  // null when the cursor ray misses the box — the app then leaves the marker/camera be. `purpose`
  // and `focusDistance` are echoed from the request so the app routes the point (place vs
  // place+focus) at the distance the gesture committed to.
  | {
      readonly kind: "pickResult";
      readonly requestId: number;
      readonly point: Vec3 | null;
      readonly purpose: PickPurpose;
      readonly focusDistance?: number;
    }
  | { readonly kind: "error"; readonly requestId: number; readonly message: string }
  // Terminal GPU failure: the device was lost and the recovery circuit-breaker stopped re-acquiring
  // (repeated rapid losses) or no adapter is available. The render loop is halted; the app surfaces a
  // "reload" state rather than the silent spiral that would otherwise crash the GPU process.
  | {
      readonly kind: "gpuRecoveryFailed";
      readonly requestId: number;
      readonly reason: GpuRecoveryReason;
      readonly message: string;
    };
