import {
  REQUEST_IDS,
  type RenderWorkerRequest,
  type RenderWorkerResponse,
} from "@render/messages.ts";
import type { SimulationStore, UiStore } from "@store";
import type { RenderWorkerLink } from "./storeBridge.ts";

// PNG-screenshot glue (app-only: ui dispatches the store intent, the worker captures). Subscribes
// to uiStore.screenshotSerial → posts the capture request; deliverScreenshot (routed from main.ts
// onmessage) downloads the returned Blob via an object-URL anchor click. One capture in flight at
// a time; the pending loading pill ends on the reply, which the worker posts even on failure
// (blob: null — the never-strand contract).

export interface ScreenshotBridgeOptions extends RenderWorkerLink {
  readonly store: SimulationStore;
  readonly uiStore: UiStore;
  // Receives the finished PNG; defaults to an anchor-click download (no-op headless).
  readonly deliver?: (blob: Blob, filename: string) => void;
}

export interface ScreenshotBridge {
  readonly deliverScreenshot: (
    message: Extract<RenderWorkerResponse, { kind: "screenshot" }>,
  ) => void;
  readonly dispose: () => void;
}

const PHASE_KEY = "screenshot";

function sanitizeFilePart(part: string): string {
  return part.replace(/[^\w.-]+/g, "_");
}

function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Safe immediately after click(): the download has already begun from the object URL.
  URL.revokeObjectURL(url);
}

export function installScreenshotBridge(options: ScreenshotBridgeOptions): ScreenshotBridge {
  const { store, uiStore, worker, isReady } = options;
  const deliver = options.deliver ?? downloadBlob;
  let isInFlight = false;

  const unsubscribe = uiStore.subscribe(
    (state) => state.screenshotSerial,
    () => {
      if (!isReady() || isInFlight) return;
      isInFlight = true;
      uiStore.getState().beginLoading(PHASE_KEY, "saving png");
      worker.postMessage({
        kind: "screenshot",
        requestId: REQUEST_IDS.screenshot,
      } satisfies RenderWorkerRequest);
    },
  );

  return {
    deliverScreenshot(message) {
      isInFlight = false;
      uiStore.getState().endLoading(PHASE_KEY);
      if (message.blob === null) return; // capture failed — reported on the error channel
      const state = store.getState();
      const filename = `webpic-${sanitizeFilePart(state.datasetId)}-step${state.currentStep}.png`;
      deliver(message.blob, filename);
    },
    dispose() {
      unsubscribe();
    },
  };
}
