import type { StreamStepMessage } from "@data";
import { finiteRange } from "@reductions";
import type { ColorScale, WindowLevel } from "@schema/colormap.ts";
import { fullRangeWindow } from "@schema/colormap.ts";
import type { LayerKind } from "@schema/layers.ts";
import { UNIT_BOX_HALF_EXTENT } from "@schema/math.ts";
import type { Rgba01 } from "@schema/theme.ts";
import type { Vec3 } from "@schema/types.ts";
import type { Camera } from "three";
import { createFieldlinesScene, type FieldlinesScene } from "./fieldlines/fieldlinesScene.ts";
import { warmScene } from "./managedScene.ts";
import type {
  FieldLayerKind,
  FieldLayerParams,
  RenderWorkerRequest,
  SliceFieldPayload,
} from "./messages.ts";
import type { PickLayer } from "./pickRay.ts";
import type { RenderModule, RenderModuleContext } from "./renderModule.ts";
import type { CompositeItem } from "./runtime/renderer.ts";
import {
  createRaymarchScene,
  type RaymarchMaterialBuilder,
  type RaymarchScene,
} from "./volume/raymarchScene.ts";
import { createSliceScene, type SliceScene } from "./volume/sliceScene.ts";
import { NO_FINITE_RANGE, type ScalarField } from "./volume/volumeTexture.ts";

// Everything needed to rebuild a field layer's scene without the main thread: the decoded field (its
// CPU buffer survives a GPU device loss) plus the live build params. field/colormap/scale/window/opacity
// are mutable — swapField/setColormap/setComposite update them so a device-loss rebuild reproduces the
// current state (the live timestep + look), not the stale upsert-time one. Retaining the field doubles
// its residency (CPU + GPU); fine for v0.1's one small volume, and the price of self-contained
// recovery (no reseed wire).
interface FieldSource {
  readonly layerKind: FieldLayerKind;
  field: ScalarField; // mutable: a streamed timestep swaps it in place (see swapField)
  colormap: string;
  scale: ColorScale;
  windowLevel?: WindowLevel;
  opacity: number;
  // The kind's build params (`layerKind` agrees with the entry's). Replaced by a live setSliceParams /
  // setLayerShading edit so a device-restore rebuild reproduces the current hold + look.
  params: FieldLayerParams;
}

// A field-line layer's retained source: packed world-space polylines (positions + per-line counts) +
// solid color + opacity. The CPU buffers survive a device loss, so a restore rebuild redraws the same
// lines with no re-trace — the line analogue of FieldSource retaining the decoded field.
interface FieldlinesSource {
  readonly layerKind: "fieldlines";
  lines: { positions: Float32Array; counts: Uint32Array };
  color: Rgba01; // mutable so a device-restore rebuild keeps the live color
  opacity: number;
}

type LayerSource = FieldSource | FieldlinesSource;

// Which camera composites each kind: slices are screen-aligned (ortho); volumes and field lines live in
// the box under the pose camera. A complete record, so a new kind must declare its camera.
const LAYER_CAMERA: Readonly<Record<LayerKind, "ortho" | "pose">> = {
  slice: "ortho",
  volume: "pose",
  fieldlines: "pose",
};

function cameraFor(kind: LayerKind, pose: Camera, ortho: Camera): Camera {
  return LAYER_CAMERA[kind] === "ortho" ? ortho : pose;
}

// One renderable layer's scene + its kind (the kind picks the camera at composite time) + the source
// it was built from (replayed on device-restore). Discriminated on `kind` so narrowing it narrows the
// scene + source together (a fieldlines entry has no field/window to touch).
export type LayerEntry =
  | {
      readonly kind: FieldLayerKind;
      readonly scene: SliceScene | RaymarchScene;
      readonly source: FieldSource;
    }
  | {
      readonly kind: "fieldlines";
      readonly scene: FieldlinesScene;
      readonly source: FieldlinesSource;
    };

// The ordered visibility/opacity view of the layer stack (draw order = array order).
interface CompositeEntry {
  readonly id: string;
  readonly visible: boolean;
  readonly opacity: number;
}

// The render-context the layer lifecycle reaches back into: live quality/projection (re-asserted on
// freshly built scenes), the repaint + fault-report seams, and `warmComposite` — which compiles the
// *full* prospective composite (layers + overlay + marker), so it lives in the worker (the registry
// doesn't own overlay/marker/cameras).
export interface LayerHost extends RenderModuleContext {
  hasFloat32Filterable(): boolean;
  stepScale(): number;
  isOrthographic(): boolean;
  warmComposite(override: {
    readonly id: string;
    readonly entry: LayerEntry;
  }): Promise<unknown> | undefined;
}

export interface LayerRegistry extends RenderModule {
  upsert(request: Extract<RenderWorkerRequest, { kind: "upsertLayer" }>): Promise<void>;
  upsertFieldlines(
    request: Extract<RenderWorkerRequest, { kind: "upsertFieldlines" }>,
  ): Promise<void>;
  remove(id: string): void;
  swapField(message: StreamStepMessage): void;
  setComposite(order: readonly CompositeEntry[]): void;
  setColormap(request: Extract<RenderWorkerRequest, { kind: "setLayerColormap" }>): void;
  setShading(request: Extract<RenderWorkerRequest, { kind: "setLayerShading" }>): void;
  setSliceParams(request: Extract<RenderWorkerRequest, { kind: "setSliceParams" }>): void;
  // Push a new interaction step-scale to every volume scene (the per-layer half of applyQuality).
  applyStepScale(stepScale: number): void;
  // Flip every volume scene's ray generation (the per-layer half of setProjection).
  applyProjection(orthographic: boolean): void;
  // Dev shader hot-reload: swap every volume scene's material from freshly imported builder code,
  // reusing each layer's uploaded texture + live uniforms (no rebuild, no re-upload). Slices have no
  // raymarch shader, so they're skipped.
  rebuildShaders(build: RaymarchMaterialBuilder): void;
  // The visible layers in draw order paired with their camera; `override` swaps in a not-yet-committed
  // scene for a warm. The worker appends overlay/marker.
  layerItems(
    volume: Camera,
    ortho: Camera,
    override?: { readonly id: string; readonly entry: LayerEntry },
    into?: CompositeItem[],
  ): CompositeItem[];
  // The visible volume layers' CPU fields + look, for the worker's opacity-weighted ray pick.
  pickLayers(): { layers: PickLayer[]; halfExtent: Vec3 };
  // Registry-only step of the restore teardown: drop the deferred-dispose entry. The worker calls it
  // after the modules' `disposeForRebuild` loop so it runs even if a dead-device dispose threw.
  clearPendingDispose(): void;
  // RenderModule (supersedeWarms / disposeForRebuild / rebuild / dispose) — the worker iterates these.
}

// The wire boundary for field data: a buffer read at the wrong dtype (or against the wrong shape)
// silently reinterprets the field instead of failing, so the sizes are checked here, once.
function decodeSliceField(payload: SliceFieldPayload): ScalarField {
  const Ctor = payload.dtype === "f64" ? Float64Array : Float32Array;
  const cells = payload.shape.reduce((product, dim) => product * dim, 1);
  const wanted = cells * Ctor.BYTES_PER_ELEMENT;
  if (payload.buffer.byteLength !== wanted) {
    throw new Error(
      `decodeSliceField: ${payload.dtype} buffer is ${payload.buffer.byteLength} bytes, shape [${payload.shape.join(", ")}] needs ${wanted}`,
    );
  }
  return { data: new Ctor(payload.buffer), shape: payload.shape };
}

export function createLayerRegistry(host: LayerHost): LayerRegistry {
  // The instance-first layer registry: per-id scenes + the ordered visibility/opacity view. The worker
  // composites the visible layers; the app drives exactly one.
  const layers = new Map<string, LayerEntry>();
  let composite: readonly CompositeEntry[] = [];
  // Superseding guard for the async warms: an id's epoch bumps on every replace/remove (and on a device
  // rebuild), so a warm that loses the race discards its scene instead of committing a stale one.
  const epochs = new Map<string, number>();
  // One scene whose dispose is deferred by a swap so the rAF loop can't sample a GPUTexture that a
  // replace just released mid-rebuild (use-after-free reads back as the magenta sentinel).
  let pendingDispose: LayerEntry | undefined;
  // Scenes being warmed but not yet committed. A look edit that lands during the warm would otherwise
  // reach only the entry about to be discarded, and the incoming scene — built from the source as it
  // was at upsert time — would silently revert it (a dataset switch does exactly this: the new
  // dataset's default color scale posts while the new layer is still compiling).
  const building = new Map<string, LayerEntry>();

  function bumpEpoch(id: string): number {
    const next = (epochs.get(id) ?? 0) + 1;
    epochs.set(id, next);
    return next;
  }

  // Build one layer's scene from its retained source — the single build path, shared by upsert and the
  // device-restore rebuild so both produce an identical scene from the same params.
  // exactOptionalPropertyTypes: only forward params that are set, so the scene factory defaults apply.
  function buildScene(id: string, source: LayerSource): LayerEntry {
    if (source.layerKind === "fieldlines") {
      const scene = createFieldlinesScene({
        positions: source.lines.positions,
        counts: source.lines.counts,
        color: source.color,
        opacity: source.opacity,
        ledgerKey: id,
      });
      return { kind: "fieldlines", scene, source };
    }
    const common = {
      field: source.field,
      colormap: source.colormap,
      scale: source.scale,
      opacity: source.opacity,
      hasFloat32Filterable: host.hasFloat32Filterable(),
      ledgerKey: id,
      ...(source.windowLevel !== undefined ? { windowLevel: source.windowLevel } : {}),
    };
    const { params } = source;
    switch (params.layerKind) {
      case "slice":
        return {
          scene: createSliceScene({ ...common, axis: params.axis, position: params.position }),
          kind: "slice",
          source,
        };
      case "volume": {
        const scene = createRaymarchScene({
          ...common,
          ...(params.steps !== undefined ? { steps: params.steps } : {}),
          ...(params.density !== undefined ? { density: params.density } : {}),
          ...(params.shaded !== undefined ? { shaded: params.shaded } : {}),
          ...(params.worldHalfExtent !== undefined
            ? { worldHalfExtent: params.worldHalfExtent }
            : {}),
        });
        // A scene built mid-gesture (stream rebuild) inherits the live interaction quality + projection.
        scene.setStepScale(host.stepScale());
        scene.setProjection(host.isOrthographic());
        return { scene, kind: "volume", source };
      }
    }
  }

  // Install a layer's scene from a fully-specified source, releasing the prior scene's Data3DTexture
  // without leaking. Warm-then-commit (managedScene): the prospective composite's pipelines compile
  // asynchronously off the render path before the swap, so the new scene's first visible frame neither
  // stalls on a sync compile nor draws half-formed. Swap-then-defer on commit: the new scene is live in
  // the map before the old one's GPUTextures are released, and the release waits one rebuild so an
  // in-flight rAF frame never samples a destroyed texture. Used by upsert (main) and as swapField's
  // fallback when an in-place ping-pong upload can't apply.
  async function replace(id: string, source: LayerSource): Promise<void> {
    const epoch = bumpEpoch(id);
    const next = buildScene(id, source);
    building.set(id, next);
    let committed: boolean;
    try {
      committed = await warmScene(
        next,
        () => host.warmComposite({ id, entry: next }),
        () => epochs.get(id) === epoch,
        (entry) => entry.scene.dispose(),
        host.reportFault,
      );
    } finally {
      if (building.get(id) === next) building.delete(id);
    }
    if (!committed) return;
    // The warm's await is a real yield: a setProjection / quality change that landed mid-warm only
    // reached committed scenes, so re-assert the live state on this one before it becomes visible.
    if ("setStepScale" in next.scene) next.scene.setStepScale(host.stepScale());
    if ("setProjection" in next.scene) next.scene.setProjection(host.isOrthographic());
    const previous = layers.get(id);
    layers.set(id, next);
    pendingDispose?.scene.dispose();
    pendingDispose = previous;
    host.requestRender();
  }

  // Push a look / shading edit onto one entry (committed or warming), keeping its retained source in
  // step so a device-restore rebuild reproduces it. Undefined entry (no such layer yet) is a no-op.
  function applyColormap(
    entry: LayerEntry | undefined,
    request: Extract<RenderWorkerRequest, { kind: "setLayerColormap" }>,
  ): void {
    if (entry === undefined || entry.kind === "fieldlines") return;
    entry.scene.setColormap(request.colormap);
    entry.scene.setWindowLevel(request.windowLevel.center, request.windowLevel.width);
    entry.scene.setScale(request.scale);
    entry.source.colormap = request.colormap;
    entry.source.windowLevel = request.windowLevel;
    entry.source.scale = request.scale;
  }

  function applyShading(entry: LayerEntry | undefined, shaded: boolean): boolean {
    if (entry === undefined || entry.kind === "fieldlines") return false;
    if (!("setShading" in entry.scene)) return false;
    entry.scene.setShading(shaded);
    const { params } = entry.source;
    if (params.layerKind === "volume") entry.source.params = { ...params, shaded }; // retained for a rebuild
    return true;
  }

  // A source with no windowLevel normalizes over its full finite range (buildScene's default) — the
  // in-app path always carries a binding window, so the scan is the defensive branch only.
  function pickWindow(source: FieldSource): WindowLevel {
    if (source.windowLevel !== undefined) return source.windowLevel;
    return fullRangeWindow(finiteRange(source.field.data) ?? NO_FINITE_RANGE);
  }

  return {
    async upsert(request) {
      const source: FieldSource = {
        layerKind: request.params.layerKind,
        field: decodeSliceField(request.field),
        colormap: request.colormap,
        scale: request.scale,
        opacity: request.opacity,
        ...(request.windowLevel !== undefined ? { windowLevel: request.windowLevel } : {}),
        params: request.params,
      };
      await replace(request.id, source);
    },

    // A field-line layer: decode the transferred polyline buffers into a retained source and build the
    // batched LineSegments2 scene through the same warm-then-commit + device-restore path as upsert.
    async upsertFieldlines(request) {
      const source: FieldlinesSource = {
        layerKind: "fieldlines",
        lines: {
          positions: new Float32Array(request.positions),
          counts: new Uint32Array(request.counts),
        },
        color: request.color,
        opacity: request.opacity,
      };
      await replace(request.id, source);
    },

    remove(id) {
      bumpEpoch(id); // an in-flight warm for this id must not resurrect the removed layer
      const entry = layers.get(id);
      layers.delete(id);
      if (entry !== undefined) {
        // Same one-frame deferral as a replace — the old composite may still list this id for a tick.
        pendingDispose?.scene.dispose();
        pendingDispose = entry;
      }
      host.requestRender();
    },

    // A streamed timestep's scalar: swap only the field on an existing layer, keeping its retained look.
    // The layer is created by main's initial upsert; a step arriving before it (or after a remove) is
    // ignored — it heals on the next upsert. The swap is an in-place ping-pong (the scene uploads into
    // its inactive Data3DTexture and re-binds — no 64 MiB rebuild). We retain the field so a
    // device-restore rebuild reproduces the live timestep. A scene that declines the in-place swap (a
    // shape change) falls back to a full rebuild.
    swapField(message) {
      const entry = layers.get(message.id);
      if (entry === undefined || entry.kind === "fieldlines") return; // streams target field layers only
      const field = decodeSliceField(message.field);
      if (entry.scene.setField(field)) {
        entry.source.field = field;
        host.requestRender();
        return;
      }
      // Fire-and-forget: the stream port's onmessage can't await; a failed rebuild is reported and the
      // next streamed step retries through the same path.
      void replace(message.id, { ...entry.source, field }).catch(host.reportFault);
    },

    // Cheap reorder/visibility/opacity over the full ordered list — retune per-layer opacity uniforms
    // (no rebuild). Field data rides the heavier upsert.
    setComposite(order) {
      const previous = new Map(composite.map((entry) => [entry.id, entry.opacity]));
      for (const entry of order) {
        if (previous.get(entry.id) === entry.opacity) continue;
        const layer = layers.get(entry.id);
        if (layer === undefined) continue;
        layer.scene.setOpacity(entry.opacity);
        layer.source.opacity = entry.opacity; // keep the retained source current for a device-restore rebuild
      }
      composite = order;
      host.requestRender();
    },

    // Live per-layer color: one layer's resolved ColormapBinding (colormap + window/level + scale).
    // Applied to the committed scene AND to one warming in the background, so an edit that lands
    // mid-warm survives the commit. A binding update ahead of the first upsert still heals on it;
    // field lines color solid at trace time (no live colormap window/scale), so they ignore this.
    setColormap(request) {
      const committed = layers.get(request.id);
      const warming = building.get(request.id);
      applyColormap(committed, request);
      if (warming !== committed) applyColormap(warming, request);
      if (committed !== undefined || warming !== undefined) host.requestRender();
    },

    // Live per-layer Phong toggle — a uniform flip on the volume scene. `setShading` exists only on
    // RaymarchScene; the `in` check narrows the union (and silently no-ops a slice — no normal to light).
    setShading(request) {
      const committed = layers.get(request.id);
      const warming = building.get(request.id);
      // toggle ahead of its upsert heals on the upsert (carries shaded); field lines have no normal.
      const applied = applyShading(committed, request.shaded);
      const alsoWarming = warming !== committed && applyShading(warming, request.shaded);
      if (applied || alsoWarming) host.requestRender();
    },

    // Live slice plane edit. Position is a uniform write (the drag hot path). Axis is baked into the
    // TSL graph, so a change rebuilds the slice scene from the RETAINED field (no re-transfer) through
    // the same warm-then-commit path as upsert. No-op for a missing id or a non-slice kind (an edit
    // ahead of the upsert heals on it — the upsert carries axis + position).
    setSliceParams(request) {
      const entry = layers.get(request.id);
      if (entry === undefined || entry.kind !== "slice") return;
      // entry.kind === "slice" doesn't narrow the scene (kind isn't correlated with the scene type in
      // the field-layer entry); `setPosition` exists only on SliceScene, so the `in` check narrows it.
      if (!("setPosition" in entry.scene)) return;
      const { params } = entry.source;
      if (params.layerKind !== "slice") return; // the entry kind says slice; params agree by construction
      let next = params;
      if (request.position !== undefined) {
        entry.scene.setPosition(request.position);
        next = { ...next, position: request.position };
      }
      const axisChanged = request.axis !== undefined && request.axis !== params.axis;
      if (request.axis !== undefined && axisChanged) next = { ...next, axis: request.axis };
      entry.source.params = next; // retained for a device-restore rebuild
      if (axisChanged) {
        // Fire-and-forget rebuild from the retained field; a failed rebuild is reported and the next
        // edit retries. The position uniform was already set above and rides the rebuilt source.
        void replace(request.id, entry.source).catch(host.reportFault);
        return; // replace() requests its own render on commit
      }
      host.requestRender();
    },

    applyStepScale(stepScale) {
      for (const entry of layers.values()) {
        if ("setStepScale" in entry.scene) entry.scene.setStepScale(stepScale);
      }
    },

    applyProjection(orthographic) {
      for (const entry of layers.values()) {
        // `setProjection` exists only on RaymarchScene; slices are screen-aligned and pose-invariant.
        if ("setProjection" in entry.scene) entry.scene.setProjection(orthographic);
      }
    },

    rebuildShaders(build) {
      // `rebuildShader` exists only on RaymarchScene (the `in` check narrows the union); a slice's
      // material isn't the hot-reloaded raymarch shader, so it's left untouched. The worker repaints +
      // re-warms after this returns (the swap itself is synchronous, no requestRender here).
      for (const entry of layers.values()) {
        if ("rebuildShader" in entry.scene) entry.scene.rebuildShader(build);
      }
    },

    layerItems(volume, ortho, override, into) {
      const items = into ?? []; // the worker's paint scratch when given — no allocation per frame
      let isOverrideListed = false;
      for (const entry of composite) {
        if (!entry.visible) continue;
        const isOverride = override !== undefined && entry.id === override.id;
        if (isOverride) isOverrideListed = true;
        const layer = isOverride ? override.entry : layers.get(entry.id);
        if (layer === undefined) continue; // composite ahead of its upsert — heals on the upsert repaint
        // Slices are screen-aligned (ortho); volume + field lines live in the box under the pose camera.
        items.push({ scene: layer.scene.scene, camera: cameraFor(layer.kind, volume, ortho) });
      }
      if (override !== undefined && !isOverrideListed) {
        items.push({
          scene: override.entry.scene.scene,
          camera: cameraFor(override.entry.kind, volume, ortho),
        });
      }
      return items;
    },

    pickLayers() {
      const result: PickLayer[] = [];
      let halfExtent: Vec3 = UNIT_BOX_HALF_EXTENT; // all volume layers share the dataset's box
      for (const entry of composite) {
        if (!entry.visible) continue;
        const layer = layers.get(entry.id);
        if (layer === undefined || layer.kind !== "volume") continue;
        const { params } = layer.source;
        if (params.layerKind !== "volume") continue; // agrees with the entry kind by construction
        halfExtent = params.worldHalfExtent ?? halfExtent;
        result.push({
          field: layer.source.field,
          windowLevel: pickWindow(layer.source),
          scale: layer.source.scale,
          density: params.density ?? 1, // the scene factory default
          opacity: entry.opacity,
        });
      }
      return { layers: result, halfExtent };
    },

    supersedeWarms() {
      for (const id of layers.keys()) bumpEpoch(id);
    },

    disposeForRebuild() {
      // Best-effort teardown inside the worker's try; a lost device throws and the worker swallows it.
      for (const layer of layers.values()) layer.scene.dispose();
      pendingDispose?.scene.dispose();
    },

    clearPendingDispose() {
      pendingDispose = undefined;
    },

    rebuild() {
      // Replace each layer's scene in place (Map.set on an existing key is safe mid-iteration).
      for (const [id, entry] of layers) layers.set(id, buildScene(id, entry.source));
    },

    dispose() {
      for (const layer of layers.values()) layer.scene.dispose();
      layers.clear();
      pendingDispose?.scene.dispose();
      pendingDispose = undefined;
    },
  };
}
