import type { RenderRequest } from "../messages.ts";
import type { LayerOrder, LayerOrderEntry } from "./order.ts";
import type { FieldSource, LayerEntry } from "./registry.ts";

// The live edits a layer accepts after it is built: draw order + opacity, the resolved colormap
// binding, the Phong toggle, and the slice plane. Split from the registry because they are one
// concern — mutate a committed scene in place and keep its retained source in step so a
// device-restore rebuild reproduces the edit — distinct from the registry's build/remove lifecycle.
// Each is a no-op for a missing id: an edit that lands ahead of the first upsert heals on it,
// because the upsert carries the same values.

interface LayerEditsHost {
  readonly host: { requestRender(): void; reportFault(error: unknown): void };
  // The committed entry for an id, and the one warming in the background (they differ mid-warm, and
  // an edit must reach both or it is lost at the commit).
  readonly entry: (id: string) => LayerEntry | undefined;
  readonly warming: (id: string) => LayerEntry | undefined;
  readonly order: LayerOrder;
  // Re-run the warm-then-commit path from a layer's retained source (a baked-in param changed).
  readonly rebuildScene: (id: string, source: FieldSource) => void;
}

export interface LayerEdits {
  setLayerOrder(order: readonly LayerOrderEntry[]): void;
  setColormap(request: RenderRequest<"setLayerColormap">): void;
  setShading(request: RenderRequest<"setLayerShading">): void;
  setSliceParams(request: RenderRequest<"setSliceParams">): void;
}

// Push a look edit onto one entry, keeping its retained source in step. Undefined entry is a no-op.
function applyColormap(
  entry: LayerEntry | undefined,
  request: RenderRequest<"setLayerColormap">,
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
  if (params.layerKind === "volume") entry.source.params = { ...params, shaded }; // for a rebuild
  return true;
}

export function createLayerEdits(deps: LayerEditsHost): LayerEdits {
  const { host, entry, warming, order, rebuildScene } = deps;
  return {
    setLayerOrder(next) {
      for (const id of order.setOrder(next)) {
        const layer = entry(id);
        const opacity = order.opacityOf(id);
        if (layer === undefined || opacity === undefined) continue;
        layer.scene.setOpacity(opacity);
        layer.source.opacity = opacity; // keep the retained source current for a rebuild
      }
      host.requestRender();
    },

    // One layer's resolved ColormapBinding (colormap + window/level + scale). Applied to the
    // committed scene AND to one warming in the background, so an edit that lands mid-warm survives
    // the commit. Field lines color solid at trace time, so they ignore this.
    setColormap(request) {
      const committed = entry(request.id);
      const inFlight = warming(request.id);
      applyColormap(committed, request);
      if (inFlight !== committed) applyColormap(inFlight, request);
      if (committed !== undefined || inFlight !== undefined) host.requestRender();
    },

    // A uniform flip on the volume scene. setShading exists only on RaymarchScene; the `in` check
    // narrows the union (and silently no-ops a slice — no normal to light).
    setShading(request) {
      const committed = entry(request.id);
      const inFlight = warming(request.id);
      const didApplyToCommitted = applyShading(committed, request.shaded);
      // applyShading mutates, so the skip belongs in control flow, not a short-circuit.
      const didApplyToWarming =
        inFlight === committed ? false : applyShading(inFlight, request.shaded);
      if (didApplyToCommitted || didApplyToWarming) host.requestRender();
    },

    // Position is a uniform write (the drag hot path). Axis is baked into the TSL graph, so a change
    // rebuilds the slice scene from the RETAINED field (no re-transfer) through the same
    // warm-then-commit path as upsert.
    setSliceParams(request) {
      const live = entry(request.id);
      if (live === undefined || live.kind !== "slice") return;
      // entry.kind === "slice" doesn't narrow the scene (kind isn't correlated with the scene type
      // in the field-layer entry); setPosition exists only on SliceScene, so `in` narrows it.
      if (!("setPosition" in live.scene)) return;
      const { params } = live.source;
      if (params.layerKind !== "slice") return; // the entry kind says slice; params agree
      let next = params;
      if (request.position !== undefined) {
        live.scene.setPosition(request.position);
        next = { ...next, position: request.position };
      }
      const hasAxisChange = request.axis !== undefined && request.axis !== params.axis;
      if (hasAxisChange) next = { ...next, axis: request.axis };
      live.source.params = next; // retained for a device-restore rebuild
      if (hasAxisChange) {
        // The position uniform was already set above and rides the rebuilt source.
        rebuildScene(request.id, live.source);
        return; // the rebuild requests its own render on commit
      }
      host.requestRender();
    },
  };
}
