import type { FieldPayload } from "@data";
import type { CameraMotion, CameraPose, CameraProjection } from "@schema/camera.ts";
import type { ColorScale, WindowLevel } from "@schema/colormap.ts";
import type { FieldLayerKind, SliceAxis } from "@schema/layers.ts";
import type { MarkerPart, PickPurpose } from "@schema/marker.ts";
import type { Rgba01 } from "@schema/theme.ts";
import type { FrameClock } from "@schema/timing.ts";
import type { Vec3 } from "@schema/types.ts";

export type { CameraMotion, CameraPose, CameraProjection, MarkerPart };

// Typed protocol for the OffscreenCanvas render worker. Discriminated unions both ways; transferables
// (OffscreenCanvas, field/pixel ArrayBuffer) move by transfer, never clone. `requestId` is genuinely
// *correlated* only for the pairs the worker answers — init→ready, renderFrame→frame,
// pickRay→pickResult; the one-way store→worker messages are fire-and-forget, so their ids are stable
// labels for error attribution, not match keys. All of them are assigned once in REQUEST_IDS below, so
// no two bridges can collide; a real allocator waits for a reply that must match one of many in flight.

// Single source of truth for every store→render-worker request id (one per posting site). Object keys
// are unique, so a collision is unrepresentable; the app bridges import these instead of hardcoding
// ints. (The data-worker stream id is separate — it lives with its sole owner, app/streamingBridge.)
export const REQUEST_IDS = {
  init: 1,
  projection: 2,
  pose: 3,
  continuous: 4,
  resize: 5,
  pair: 6,
  motion: 7,
  layer: 8,
  scene: 9,
  pick: 10,
  marker: 11,
  pickerPoint: 12,
  perf: 13,
  shaderHmr: 14,
  screenshot: 15,
  dispose: 16,
} as const;

// The scalar-field wire payload is declared once, in the layer both workers can import (@data);
// re-exported here so the render protocol reads whole.
// The layer discriminants (@schema/layers) — one home for store, wire, and render. Field layers carry
// a 3D scalar texture (slice/volume, one upsert path); field lines carry packed polylines (a separate
// upsert + scene), so the field-only upsertLayer message can't be handed a fieldlines kind.
export type { FieldLayerKind, FieldPayload };

// The per-kind build params of a field layer — what a slice needs (its held axis + plane) and what
// a volume needs (march + look + box aspect), each only on its own kind. Omitted volume params fall
// back to the scene factory defaults.
export type FieldLayerParams =
  | { readonly layerKind: "slice"; readonly axis: SliceAxis; readonly position: number }
  | {
      readonly layerKind: "volume";
      readonly steps?: number;
      readonly density?: number;
      readonly shaded?: boolean; // Phong toggle
      // Per-axis world half-extent of the volume box; default [0.5,0.5,0.5] (unit cube). Scales the
      // volume mesh to the dataset's physical aspect (non-cubic grids).
      readonly worldHalfExtent?: Vec3;
    };

// One field axis's physical extent + sample count + name, for the scene overlay's labeled grid/axes.
// FIELD-axis order (0/1/2 = pypic GridInfo). `bounds` are inclusive [min, max] in code units (the app
// derives them from GridInfo origin/spacing, or falls back to voxel [0, dim]); the worker maps field
// axes → THREE xyz internally (they coincide: overlayRemap's coordinate invariant) and treats
// the numbers opaquely.
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
      readonly showDebugScene?: boolean;
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
  // Build or rebuild one layer's scene (instance-first composite). Transfers the field buffer; the
  // kind-specific build params ride `params`, discriminated on the renderable kind.
  | {
      readonly kind: "upsertLayer";
      readonly requestId: number;
      readonly id: string;
      readonly field: FieldPayload;
      readonly colormap: string;
      readonly scale: ColorScale;
      readonly opacity: number;
      readonly windowLevel?: WindowLevel;
      readonly params: FieldLayerParams;
    }
  // Build or rebuild a field-line layer's scene from packed world-space polylines. Transfers both
  // buffers: `positions` is flat f32 xyz for every vertex of every line concatenated in line order,
  // `counts` is the u32 vertex count per line (partitions positions). The set is drawn solid
  // (`color`, derived by the app from the layer's colormap).
  | {
      readonly kind: "upsertFieldlines";
      readonly requestId: number;
      readonly id: string;
      readonly positions: ArrayBuffer;
      readonly counts: ArrayBuffer;
      readonly color: Rgba01;
      readonly opacity: number;
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
  // Live slice plane edit (slice-only). `position` is a uniform write (the drag hot path — no
  // re-transfer). `axis` is baked into the TSL graph, so a change rebuilds the slice scene from the
  // worker's RETAINED field (still no re-transfer); rare, so the rebuild is acceptable. Either may be
  // omitted — only the changed field rides the wire.
  | {
      readonly kind: "setSliceParams";
      readonly requestId: number;
      readonly id: string;
      readonly axis?: SliceAxis;
      readonly position?: number;
    }
  // Camera pose update — high-frequency, delta-only (DESIGN §Worker message protocol); the worker re-applies + repaints.
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
  // Render timing: force sustained every-frame repaints so the GPU timer yields a live stream (the
  // exit-gate workload). Off by default — timing is sampled only while continuous, so on-demand
  // interactive frames skip the per-frame GPU sync.
  | { readonly kind: "setContinuous"; readonly requestId: number; readonly continuous: boolean }
  // Dev-mode perf HUD: enable/disable the worker's lightweight per-frame sampling (CPU-encode
  // bracket + painted-frame interval EMA + a throttled GPU wall-clock + VRAM/heap snapshot).
  // Unlike setContinuous it does NOT force repaints — timing rides the frames already painting,
  // so opening the HUD never perturbs the on-demand cadence. Off by default; zero cost until set.
  | { readonly kind: "setPerfActive"; readonly requestId: number; readonly active: boolean }
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
  | { readonly kind: "pair"; readonly requestId: number; readonly port: MessagePort }
  // Capture the current composite as a PNG (the OffscreenCanvas worker's canvas.toBlob): the
  // deterministic full-res readback (never render-scaled, unaffected by a live gesture) is encoded
  // worker-side and returned as a Blob for the app to download.
  | { readonly kind: "screenshot"; readonly requestId: number }
  // Dev-only shader hot-reload: a watched edit to the raymarch WGSL/TSL fired on the main
  // thread's Vite HMR client, which forwards this so the worker re-imports the scene factory module
  // fresh (cache-busted by `timestamp`) and swaps each volume layer's MATERIAL in place — the uploaded
  // Data3DTexture + live uniforms (look) + pose are all preserved (no 64 MiB re-upload, no reload).
  // Never sent in production (gated behind `import.meta.hot` on the sender, `import.meta.env.DEV` on
  // the worker), so it costs the prod bundle nothing.
  | { readonly kind: "rebuildShader"; readonly requestId: number; readonly timestamp: number }
  // Orderly teardown before the main thread terminates the worker: every manager's dispose() runs,
  // the stream port closes, the renderer + GPU device go. Acked with `disposed`; main terminates on
  // the ack (or after a short grace period, so a wedged worker can't block the page's own teardown).
  | { readonly kind: "dispose"; readonly requestId: number };

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
  // Per-frame GPU time (DESIGN §Worker message protocol, RenderToStore). `clock` labels the source — timestamp-query is
  // GPU-only; wallclock includes JS/queue latency and must not masquerade as the pure-GPU number.
  | {
      readonly kind: "frameTiming";
      readonly gpuTimeMs: number;
      readonly clock: FrameClock;
    }
  // Dev-mode perf HUD sample (≤5 Hz while active). All wall-clock: `cpuEncodeMs` brackets
  // renderComposite (encode+submit); `frameWallMs` is the onSubmittedWorkDone bracket (NaN on
  // ticks that skipped the throttled GPU sync); `frameIntervalMs` is the painted-frame interval
  // EMA (NaN while the on-demand loop is idle). `computeMs` is omitted until a timed compute
  // pass exists. `vramBytes` is the tracked-allocation total and `vramByKey` its largest-first
  // per-key breakdown (top few, for the detail panel); `workerHeapBytes` is the render worker's
  // JS heap (null off-Chrome). `governorScale` is the frame-time governor's render-scale ceiling
  // (1 = unthrottled, dropping to 0.85/0.7 under sustained slow frames).
  | {
      readonly kind: "perfSample";
      readonly cpuEncodeMs: number;
      readonly frameWallMs: number;
      readonly frameIntervalMs: number;
      readonly isContinuous: boolean;
      readonly governorScale: number;
      readonly computeMs?: number;
      readonly vramBytes: number;
      readonly vramByKey: readonly (readonly [string, number])[];
      readonly workerHeapBytes: number | null;
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
  // A layer upsert finished warming its GPU pipelines (renderer.compileAsync over the prospective
  // composite, DESIGN §Worker message protocol) — its first paint won't hitch on a sync driver compile,
  // so the app drops the loading pill it raised on the upsert. Echoes the layer `id` (all upserts share
  // REQUEST_IDS.layer, so the id — not requestId — addresses the layer; a one-layer scene coalesces
  // them under a single pill). Fires on success, supersede, OR warm failure (the first paint then
  // sync-compiles), so the pill never strands.
  | { readonly kind: "layerCompiled"; readonly requestId: number; readonly id: string }
  // The finished PNG capture, at the readback target's physical size (logical × DPR). `blob` is
  // null when the capture failed — posted from a catch so the app's pending state never strands
  // (the layerCompiled never-strand contract); the failure itself rides the error channel.
  | {
      readonly kind: "screenshot";
      readonly requestId: number;
      readonly blob: Blob | null;
      readonly width: number;
      readonly height: number;
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
    }
  | { readonly kind: "disposed"; readonly requestId: number };
