import { cursorRay, type SimulationStore, seedFromVolume } from "@store";
import type { Disposer } from "./controls/index.ts";
import { clientToNdc } from "./pointerMath.ts";
import { createSubscriptions } from "./subscriptions.ts";

// Click-to-place field-line seeds. While the store holds a `seedPlacementLayerId` (a fieldlines layer
// in placement mode), a primary canvas click drops one seed at the cursor and re-traces; otherwise the
// handler is inert and the click falls through to the picker / camera. ui → store only. The seed comes
// from the cursor ray against the volume box (`seedFromVolume`, "midpoint" — inside a centered
// structure rather than on the near face), no worker round-trip. Capture phase, installed BEFORE the
// picker so it claims the click first while placing: the user wants a seed, not a marker grab.

export function installPointerSeedPlacer(target: HTMLElement, store: SimulationStore): Disposer {
  const abortController = new AbortController();
  const { signal } = abortController;
  const doc = target.ownerDocument;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary) return;
    const state = store.getState();
    const layerId = state.seedPlacementLayerId;
    if (layerId === null || state.dataset === null) return; // not placing → let picker/camera handle it
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    event.stopImmediatePropagation(); // claim the click before the picker/camera
    event.preventDefault();
    const { x, y } = clientToNdc(event.clientX, event.clientY, rect);
    const ray = cursorRay(
      state.cameraPose,
      x,
      y,
      rect.width / rect.height,
      state.projection === "orthographic",
    );
    const seed = seedFromVolume(
      ray.origin,
      ray.dir,
      state.dataset.grid,
      state.worldHalfExtent,
      "midpoint",
    );
    if (seed !== null) store.getState().addFieldlineSeed(layerId, seed);
  };

  // Esc leaves placement mode (mirrors the panel's "Place seeds" toggle going off).
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && store.getState().seedPlacementLayerId !== null) {
      store.getState().setSeedPlacement(null);
    }
  };

  // A crosshair cursor makes the mode legible while it's on.
  const applyCursor = (layerId: string | null): void => {
    target.style.cursor = layerId !== null ? "crosshair" : "";
  };

  target.addEventListener("pointerdown", onPointerDown, { signal, capture: true });
  doc.addEventListener("keydown", onKeyDown, { signal });
  const subscriptions = createSubscriptions();
  subscriptions.on(store, (s) => s.seedPlacementLayerId, applyCursor, { fireNow: true });

  return () => {
    abortController.abort();
    subscriptions.dispose();
    target.style.cursor = "";
  };
}
