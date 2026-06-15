import type { StreamStepMessage } from "@data";
import type { ColorScale, WindowLevel } from "@schema/colormap.ts";
import { UNIT_BOX_HALF_EXTENT } from "@schema/math.ts";
import type { Vec3 } from "@schema/types.ts";
import type { Camera } from "three";
import { warmScene } from "./managedScene.ts";
import type { LayerKind, RenderWorkerRequest, SliceFieldPayload } from "./messages.ts";
import type { PickLayer } from "./pickRay.ts";
import type { CompositeItem } from "./renderer.ts";
import type { RenderModule, RenderModuleContext } from "./renderModule.ts";
import { fullRangeWindow } from "./volume/normalization.ts";
import { createRaymarchScene, type RaymarchScene } from "./volume/raymarchScene.ts";
import { createSliceScene, type SliceAxis, type SliceScene } from "./volume/sliceScene.ts";
import { finiteRange, type ScalarField } from "./volume/volumeTexture.ts";

// Everything needed to rebuild a layer's scene without the main thread: the decoded field (its CPU
// buffer survives a GPU device loss) plus the live build params. field/colormap/scale/window/opacity
// are mutable — swapField/setColormap/setComposite update them so a device-loss rebuild reproduces the
// current state (the live timestep + look), not the stale upsert-time one. Retaining the field doubles
// its residency (CPU + GPU); fine for v0.1's one small volume, and the price of self-contained
// recovery (no reseed wire).
export interface LayerSource {
  readonly layerKind: LayerKind;
  field: ScalarField; // mutable: a streamed timestep swaps it in place (see swapField)
  readonly axis?: SliceAxis;
  readonly position?: number;
  readonly steps?: number;
  readonly density?: number;
  colormap: string;
  scale: ColorScale;
  windowLevel?: WindowLevel;
  shaded?: boolean; // volume Phong toggle — mutable so a device-restore rebuild keeps the live state
  opacity: number;
  worldHalfExtent?: Vec3; // volume box aspect (non-cubic dataset); retained for a device-restore rebuild
}

// One renderable layer's scene + its kind (the kind picks the camera at composite time) + the source
// it was built from (replayed on device-restore).
export interface LayerEntry {
  readonly scene: SliceScene | RaymarchScene;
  readonly kind: LayerKind;
  readonly source: LayerSource;
}

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
  float32Filterable(): boolean;
  stepScale(): number;
  isOrthographic(): boolean;
  warmComposite(override: {
    readonly id: string;
    readonly entry: LayerEntry;
  }): Promise<unknown> | undefined;
}

export interface LayerRegistry extends RenderModule {
  upsert(request: Extract<RenderWorkerRequest, { kind: "upsertLayer" }>): Promise<void>;
  remove(id: string): void;
  swapField(message: StreamStepMessage): void;
  setComposite(order: readonly CompositeEntry[]): void;
  setColormap(request: Extract<RenderWorkerRequest, { kind: "setLayerColormap" }>): void;
  setShading(request: Extract<RenderWorkerRequest, { kind: "setLayerShading" }>): void;
  /** Push a new interaction step-scale to every volume scene (the per-layer half of applyQuality). */
  applyStepScale(stepScale: number): void;
  /** Flip every volume scene's ray generation (the per-layer half of setProjection). */
  applyProjection(orthographic: boolean): void;
  /** The visible layers in draw order paired with their camera; `override` swaps in a not-yet-committed
   *  scene for a warm. The worker appends overlay/marker. */
  layerItems(
    volume: Camera,
    ortho: Camera,
    override?: { readonly id: string; readonly entry: LayerEntry },
  ): CompositeItem[];
  /** The visible volume layers' CPU fields + look, for the worker's opacity-weighted ray pick. */
  pickLayers(): { layers: PickLayer[]; halfExtent: Vec3 };
  /** Registry-only step of the restore teardown: drop the deferred-dispose entry. The worker calls it
   *  after the modules' `disposeForRebuild` loop so it runs even if a dead-device dispose threw. */
  clearPendingDispose(): void;
  // RenderModule (supersedeWarms / disposeForRebuild / rebuild / dispose) — the worker iterates these.
}

export function createLayerRegistry(host: LayerHost): LayerRegistry {
  // The instance-first layer registry: per-id scenes + the ordered visibility/opacity view. The worker
  // composites the visible layers; the app drives exactly one for now.
  const layers = new Map<string, LayerEntry>();
  let composite: readonly CompositeEntry[] = [];
  // Superseding guard for the async warms: an id's epoch bumps on every replace/remove (and on a device
  // rebuild), so a warm that loses the race discards its scene instead of committing a stale one.
  const epochs = new Map<string, number>();
  // One scene whose dispose is deferred by a swap so the rAF loop can't sample a GPUTexture that a
  // replace just released mid-rebuild (use-after-free reads back as the magenta sentinel).
  let pendingDispose: LayerEntry | undefined;

  function bumpEpoch(id: string): number {
    const next = (epochs.get(id) ?? 0) + 1;
    epochs.set(id, next);
    return next;
  }

  function decodeSliceField(payload: SliceFieldPayload): ScalarField {
    const data =
      payload.dtype === "f64" ? new Float64Array(payload.buffer) : new Float32Array(payload.buffer);
    return { data, shape: payload.shape };
  }

  // Build one layer's scene from its retained source — the single build path, shared by upsert and the
  // device-restore rebuild so both produce an identical scene from the same params.
  // exactOptionalPropertyTypes: only forward params that are set, so the scene factory defaults apply.
  function buildScene(source: LayerSource): LayerEntry {
    const windowLevel = source.windowLevel !== undefined ? { windowLevel: source.windowLevel } : {};
    const float32Filterable = host.float32Filterable();
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
      ...(source.worldHalfExtent !== undefined ? { worldHalfExtent: source.worldHalfExtent } : {}),
    });
    // A scene built mid-gesture (stream rebuild) inherits the live interaction quality + projection.
    scene.setStepScale(host.stepScale());
    scene.setProjection(host.isOrthographic());
    return { scene, kind: "volume", source };
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
    const next = buildScene(source);
    const committed = await warmScene(
      next,
      () => host.warmComposite({ id, entry: next }),
      () => epochs.get(id) === epoch,
      (entry) => entry.scene.dispose(),
      host.reportFault,
    );
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

  // A source with no windowLevel normalizes over its full finite range (buildScene's default) — the
  // in-app path always carries a binding window, so the scan is the defensive branch only.
  function pickWindow(source: LayerSource): WindowLevel {
    if (source.windowLevel !== undefined) return source.windowLevel;
    const { min, max } = finiteRange(source.field.data);
    return fullRangeWindow(min, max);
  }

  return {
    async upsert(request) {
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
        ...(request.worldHalfExtent !== undefined
          ? { worldHalfExtent: request.worldHalfExtent }
          : {}),
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
    // device-restore rebuild reproduces the live timestep. If the scene declines the in-place swap (a
    // shape change, or an empty-space-skip volume whose acceleration grid would go stale), fall back to
    // a full rebuild.
    swapField(message) {
      const entry = layers.get(message.id);
      if (entry === undefined) return;
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
    setColormap(request) {
      const entry = layers.get(request.id);
      if (entry === undefined) return; // binding update ahead of its upsert — heals on the upsert repaint
      entry.scene.setColormap(request.colormap);
      entry.scene.setWindowLevel(request.windowLevel.center, request.windowLevel.width);
      entry.scene.setScale(request.scale);
      // Keep the retained source current so a device-restore rebuild reproduces the live color.
      entry.source.colormap = request.colormap;
      entry.source.windowLevel = request.windowLevel;
      entry.source.scale = request.scale;
      host.requestRender();
    },

    // Live per-layer Phong toggle — a uniform flip on the volume scene. `setShading` exists only on
    // RaymarchScene; the `in` check narrows the union (and silently no-ops a slice — no normal to light).
    setShading(request) {
      const entry = layers.get(request.id);
      if (entry === undefined) return; // toggle ahead of its upsert — heals on the upsert (carries shaded)
      if ("setShading" in entry.scene) {
        entry.scene.setShading(request.shaded);
        entry.source.shaded = request.shaded; // retain for a device-restore rebuild
        host.requestRender();
      }
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

    layerItems(volume, ortho, override) {
      const items: CompositeItem[] = [];
      let isOverrideListed = false;
      for (const entry of composite) {
        if (!entry.visible) continue;
        const isOverride = override !== undefined && entry.id === override.id;
        if (isOverride) isOverrideListed = true;
        const layer = isOverride ? override.entry : layers.get(entry.id);
        if (layer === undefined) continue; // composite ahead of its upsert — heals on the upsert repaint
        items.push({ scene: layer.scene.scene, camera: layer.kind === "volume" ? volume : ortho });
      }
      if (override !== undefined && !isOverrideListed) {
        items.push({
          scene: override.entry.scene.scene,
          camera: override.entry.kind === "volume" ? volume : ortho,
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
        halfExtent = layer.source.worldHalfExtent ?? halfExtent;
        result.push({
          field: layer.source.field,
          windowLevel: pickWindow(layer.source),
          scale: layer.source.scale,
          density: layer.source.density ?? 1, // the scene factory default
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
      for (const [id, entry] of layers) layers.set(id, buildScene(entry.source));
    },

    dispose() {
      for (const layer of layers.values()) layer.scene.dispose();
      layers.clear();
      pendingDispose?.scene.dispose();
      pendingDispose = undefined;
    },
  };
}
