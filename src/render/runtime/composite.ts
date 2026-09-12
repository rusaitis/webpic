import type { Camera, OrthographicCamera, PerspectiveCamera } from "three";
import type { DebugTriangle } from "../debugTriangle.ts";
import type { LayerEntry } from "../layer/registry.ts";
import type { MarkerScene } from "../marker/markerScene.ts";
import type { OverlayScene } from "../overlay/overlayScene.ts";
import type { CompositeDrawItem } from "./renderer.ts";

// Composite assembly: the visible layers in draw order, each paired with the camera its projection
// needs (perspective for volumes, orthographic for slices), the overlay + marker chrome on top. The
// overrides splice a not-yet-committed scene in so a warm can compile the *prospective* composite's
// pipelines before its commit makes it paintable; the scratch list keeps the per-frame paint path
// allocation-free.
interface LayerOverride {
  readonly id: string;
  readonly entry: LayerEntry;
}

export interface CompositeAssemblerHost {
  // The visible layers in draw order paired with their cameras (registry.layerItems).
  layerItems(
    volume: Camera,
    ortho: Camera,
    override?: LayerOverride,
    into?: CompositeDrawItem[],
  ): CompositeDrawItem[];
  overlay(): OverlayScene | undefined;
  marker(): MarkerScene | undefined;
  // The pose-driven volume camera for the live projection; undefined before init.
  volumeCamera(): PerspectiveCamera | OrthographicCamera | undefined;
  // The screen-aligned ortho camera (slices + boot); undefined before init.
  orthoCamera(): OrthographicCamera | undefined;
  // The opt-in debug triangle drawn when the composite is empty.
  testScene(): DebugTriangle | undefined;
}

export interface CompositeAssembler {
  // The composite a warm compiles: `layerOverride` swaps in (or appends, when the composite doesn't
  // list the id yet — the boot upsert precedes setComposite) a not-yet-committed layer scene;
  // `overlayOverride` / `markerOverride` a not-yet-committed decoration (null = none).
  compositeItems(
    layerOverride?: LayerOverride,
    overlayOverride?: OverlayScene | null,
    markerOverride?: MarkerScene | null,
  ): CompositeDrawItem[];
  // What the next paint draws, freshly allocated — for the async warms and readbacks.
  paintItems(): CompositeDrawItem[];
  // The same list refilled in place, for the synchronous paint path only: warms and readbacks are
  // async and would see it mutate under them, so they take the allocating paintItems().
  scratchPaintItems(): readonly CompositeDrawItem[];
}

export function createCompositeAssembler(host: CompositeAssemblerHost): CompositeAssembler {
  const paintScratch: CompositeDrawItem[] = [];

  function assemble(
    layerOverride: LayerOverride | undefined,
    overlayOverride: OverlayScene | null | undefined,
    markerOverride: MarkerScene | null | undefined,
    into: CompositeDrawItem[] | undefined,
  ): CompositeDrawItem[] {
    const volume = host.volumeCamera();
    const ortho = host.orthoCamera();
    if (volume === undefined || ortho === undefined) {
      throw new Error("compositeAssembler: render before init — no renderer installed yet");
    }
    const items = host.layerItems(volume, ortho, layerOverride, into);
    // The overlay + marker composite last (on top), paired with the SAME pose-driven camera as the
    // volumes (else they'd misalign under an ortho volume) — and only when a volume layer is present.
    // 3D chrome over a flat ortho slice or an empty frame is meaningless; a volume whose upsert hasn't
    // landed yet heals on its upsert repaint.
    let hasVolume = false;
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.camera === volume) {
        hasVolume = true;
        break;
      }
    }
    const effectiveOverlay =
      overlayOverride === undefined ? host.overlay() : (overlayOverride ?? undefined);
    if (effectiveOverlay !== undefined && hasVolume) {
      items.push({ scene: effectiveOverlay.scene, camera: volume });
    }
    const effectiveMarker =
      markerOverride === undefined ? host.marker() : (markerOverride ?? undefined);
    if (effectiveMarker !== undefined && hasVolume) {
      items.push({ scene: effectiveMarker.scene, camera: volume });
    }
    return items;
  }

  // The composited layers, the opt-in debug triangle when empty, else nothing — renderComposite([])
  // presents the bare clear color, the flash-free boot/empty frame.
  function paintInto(into: CompositeDrawItem[] | undefined): CompositeDrawItem[] {
    const ortho = host.orthoCamera();
    if (ortho === undefined) {
      throw new Error("compositeAssembler: render before init — no renderer installed yet");
    }
    if (into !== undefined) into.length = 0;
    const items = assemble(undefined, undefined, undefined, into);
    const testScene = host.testScene();
    if (items.length === 0 && testScene !== undefined) {
      items.push({ scene: testScene.scene, camera: ortho });
    }
    return items;
  }

  return {
    compositeItems: (layerOverride, overlayOverride, markerOverride) =>
      assemble(layerOverride, overlayOverride, markerOverride, undefined),
    paintItems: () => paintInto(undefined),
    scratchPaintItems: () => paintInto(paintScratch),
  };
}
