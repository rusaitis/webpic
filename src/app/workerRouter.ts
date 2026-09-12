import type { RenderWorkerResponse } from "@render/messages.ts";
import { logError } from "@schema/log.ts";
import type { PerfStore, UiStore } from "@store";
import { showBlockingBanner } from "./blockingBanner.ts";

// Every render-worker reply, routed to whoever owns it. Bootstrap wires the seams; the switch lives
// here so its exhaustiveness — a new response kind is a compile error until it is handled — reads
// without the rest of boot around it.
//
// Two replies are terminal rather than routed: a pre-first-frame `error` and `gpuRecoveryFailed` put
// up a blocking banner, because the status pill auto-clears and the user would otherwise be left
// staring at an empty canvas.

export interface WorkerRouterHost {
  readonly uiStore: UiStore;
  readonly perfStore: PerfStore;
  // Clears the boot pill; called before a terminal banner so no spinner sits behind it.
  readonly endBootPhase: () => void;
  readonly isWorkerReady: () => boolean;
  readonly onReady: () => void;
  readonly ingestRenderSample: (
    message: Extract<RenderWorkerResponse, { kind: "perfSample" }>,
  ) => void;
  readonly applyPickResult: (
    message: Extract<RenderWorkerResponse, { kind: "pickResult" }>,
  ) => void;
  readonly finishLayerLoading: () => void;
  readonly deliverScreenshot: (
    message: Extract<RenderWorkerResponse, { kind: "screenshot" }>,
  ) => void;
  // The worker acked `dispose`; terminate now instead of waiting out the grace timer.
  readonly onDisposed: () => void;
}

export function routeWorkerResponse(message: RenderWorkerResponse, host: WorkerRouterHost): void {
  switch (message.kind) {
    case "ready":
      host.onReady();
      return;
    case "frame":
      return; // the readback reply of the headless render path — screenshots ride `screenshot`
    case "frameTiming":
      host.perfStore.getState().setFrameTiming(message.gpuTimeMs, message.clock);
      return;
    case "perfSample":
      host.ingestRenderSample(message);
      return;
    case "pickResult":
      host.applyPickResult(message);
      return;
    case "layerCompiled":
      host.finishLayerLoading(); // the layer's pipeline is warm → drop the render-loading pill
      return;
    case "screenshot":
      host.deliverScreenshot(message);
      return;
    case "error":
      logError("render worker", message.message);
      if (!host.isWorkerReady()) {
        host.endBootPhase();
        showBlockingBanner("webpic could not start the WebGPU renderer.", {
          detail: message.message,
          reload: true,
        });
      }
      return;
    case "gpuRecoveryFailed":
      logError("render worker", `GPU unrecoverable (${message.reason}): ${message.message}`);
      host.endBootPhase();
      showBlockingBanner(`GPU device lost and could not recover. ${message.message}`, {
        reload: true,
      });
      return;
    case "disposed":
      host.onDisposed();
      return;
    default: {
      const unreachable: never = message;
      logError("render worker", "unknown response", unreachable);
    }
  }
}
