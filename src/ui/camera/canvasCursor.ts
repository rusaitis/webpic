import type { SimulationStore } from "@store";
import type { Disposer } from "../controls/index.ts";
import { createSubscriptions } from "../subscriptions.ts";

// Single writer for the canvas cursor. A marker grab or a camera drag reads "grabbing", a marker
// hover reads "pointer", everything else rests on "grab". The picker never writes style.cursor
// itself — it reports intent through the store (pickerActive/pickerHover) — so the two never race.
// Also owns touch-action, since both are canvas-wide styles restored together on teardown.

export interface CanvasCursor {
  // Re-read the store and apply; the gesture path calls it on every pointer down/up.
  apply(): void;
  dispose: Disposer;
}

export function installCanvasCursor(
  target: HTMLElement,
  store: SimulationStore,
  hasLivePointers: () => boolean,
): CanvasCursor {
  const apply = (): void => {
    const { pickerActive, pickerHover } = store.getState();
    target.style.cursor =
      pickerActive || hasLivePointers() ? "grabbing" : pickerHover !== "none" ? "pointer" : "grab";
  };

  const subscriptions = createSubscriptions();
  subscriptions.on(store, (s) => s.pickerActive, apply);
  subscriptions.on(store, (s) => s.pickerHover, apply);

  const priorTouchAction = target.style.touchAction;
  const priorCursor = target.style.cursor;
  target.style.touchAction = "none"; // touch-drag should orbit, not scroll the page
  apply();

  return {
    apply,
    dispose() {
      subscriptions.dispose();
      target.style.touchAction = priorTouchAction;
      target.style.cursor = priorCursor;
    },
  };
}
