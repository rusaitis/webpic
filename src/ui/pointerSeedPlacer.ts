import { cursorRay, type SimulationStore, seedFromVolume } from "@store";
import type { Disposer } from "./controls/index.ts";
import { clientToNdc } from "./pointerMath.ts";

// Click-to-place field-line seeds. While the store holds a `seedPlacementLayerId` (a fieldlines
// layer in placement mode, toggled from its settings panel), a primary canvas click drops one seed at
// the cursor and re-traces; otherwise the handler is inert and the click falls through to the picker /
// camera. ui → store only.
//
// The seed is computed on the CPU from the cursor ray (`cursorRay`) against the volume box
// (`seedFromVolume`, "midpoint" — lands inside a centered structure rather than on the near face). No
// worker round-trip: the pure geometric pick is enough here; GPU opacity-weighted depth (the dominant
// structure along the ray) is the render/pickRay path, a later refinement.
//
// Capture phase, like ui/pointerPicker — and it must be installed BEFORE the picker so it claims the
// click first while placing (the user wants a seed, not a marker grab / orbit).

export function installPointerSeedPlacer(target: HTMLElement, store: SimulationStore): Disposer {
  const ac = new AbortController();
  const { signal } = ac;
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
  applyCursor(store.getState().seedPlacementLayerId);
  const unsub = store.subscribe((s) => s.seedPlacementLayerId, applyCursor);

  return () => {
    ac.abort();
    unsub();
    target.style.cursor = "";
  };
}
