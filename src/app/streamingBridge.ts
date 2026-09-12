import type { DataHandle, DataStreamRequest, DataStreamResponse } from "@data";
import { REQUEST_IDS, type RenderWorkerRequest } from "@render/messages.ts";
import { logError } from "@schema/log.ts";
import type { SimulationStore, UiStore } from "@store";

// Owns the streaming data worker (app-only glue). The worker reads + computes each scrubbed step
// off-main and streams the scalar straight to the render worker over a private MessageChannel (no main
// hop); main relays only the timestep domain (→ setAvailableSteps) and drives the cursor + active
// field. The render-side port pairs into the render worker on its `ready` (pair()); the data-side port
// rides the open message once the store has seeded its layer (open()).

// The data worker's request label — its sole posting module, so a local const, not render REQUEST_IDS.
const STREAM_REQUEST_ID = 7;

export interface StreamingBridgeOptions {
  readonly store: SimulationStore;
  readonly uiStore: UiStore;
  // The render worker — the streaming port pairs into it on its `ready`.
  readonly renderWorker: Pick<Worker, "postMessage">;
  readonly dataWorker: Worker;
  // The multi-step source the cursor scrubs through.
  readonly streamSource: DataHandle;
  // Dev perf HUD: forward the data worker's ~1 Hz self-report (heap + last read time).
  readonly onPerfSample?: (sample: {
    readonly heapBytes: number | null;
    readonly lastReadMs: number | null;
  }) => void;
}

export interface StreamingBridge {
  // Open the source onto the seeded layer (call once after the store's setDataset).
  readonly open: () => void;
  // Pair the streaming port into the render worker (call on the render worker's `ready`).
  readonly pair: () => void;
  // Swap the source onto a new handle for a dataset switch; no-op until the stream is open.
  readonly reopen: (handle: DataHandle) => void;
  // Dev perf HUD: enable/disable the data worker's self-report.
  readonly setPerfActive: (active: boolean) => void;
  readonly dispose: () => void;
}

export function installStreamingBridge(options: StreamingBridgeOptions): StreamingBridge {
  const { store, uiStore, renderWorker, dataWorker, streamSource } = options;
  const channel = new MessageChannel();
  let isOpened = false; // gates cursor/field/reopen posts until the worker has its reader
  let hasStreamedStep = false; // the worker only re-streams a field switch after a first scrub

  dataWorker.onmessage = (event: MessageEvent<DataStreamResponse>) => {
    const message = event.data;
    switch (message.kind) {
      case "opened":
        store.getState().setAvailableSteps(message.steps); // override the 1-element seed
        uiStore.getState().endLoading("open");
        return;
      case "stepLoaded":
        // Only the ack for the *current* cursor ends the phase — a stale ack in transit from a
        // scrubbed-past step must not clear the newer load's pill.
        if (message.step === store.getState().currentStep) uiStore.getState().endLoading("step");
        return;
      case "streamError":
        logError("data worker", message.message);
        uiStore.getState().endLoading("open");
        uiStore.getState().endLoading("step");
        uiStore.getState().flashError(message.message);
        return;
      case "perfSample":
        options.onPerfSample?.({ heapBytes: message.heapBytes, lastReadMs: message.lastReadMs });
        return;
      default: {
        const unreachable: never = message;
        logError("data worker", "unknown response", unreachable);
      }
    }
  };

  // Cursor (scrub control) → data worker; the worker re-reads + re-streams off-main.
  const unsubscribeStep = store.subscribe(
    (state) => state.currentStep,
    (step) => {
      if (!isOpened) return;
      dataWorker.postMessage({
        kind: "setCursor",
        requestId: STREAM_REQUEST_ID,
        step,
      } satisfies DataStreamRequest);
      hasStreamedStep = true;
      // Rapid scrubs just retitle the live "step" phase; the stepLoaded ack ends it. Cached neighbours
      // ack within ms — inside the pill's show delay, so no flash.
      uiStore.getState().beginLoading("step", `loading step ${step}`);
    },
  );

  // Active field (field selector) → data worker; the worker re-points the computed quantity.
  const unsubscribeActiveField = store.subscribe(
    (state) => state.activeField,
    (field) => {
      if (!isOpened) return;
      dataWorker.postMessage({
        kind: "setActiveField",
        requestId: STREAM_REQUEST_ID,
        field,
      } satisfies DataStreamRequest);
      // Pre-scrub the worker has no cursor and never acks (main's synchronous layerBridge covers that
      // case) — an unconditional begin would strand the phase forever.
      if (hasStreamedStep) uiStore.getState().beginLoading("step", `computing ${field}`);
    },
  );

  return {
    open() {
      // The store seeds its layer in setDataset (streamed fields address it by id); open after that.
      const layerId = store.getState().selectedLayerId;
      if (layerId === null) return;
      uiStore.getState().beginLoading("open", "opening dataset");
      dataWorker.postMessage(
        {
          kind: "open",
          requestId: STREAM_REQUEST_ID,
          handle: streamSource,
          activeField: store.getState().activeField,
          layerId,
          port: channel.port1,
        } satisfies DataStreamRequest,
        [channel.port1], // transfer the data-side port
      );
      isOpened = true;
    },
    pair() {
      // Buffered until the render worker sets the port's onmessage, so no streamed step is lost.
      renderWorker.postMessage(
        {
          kind: "pair",
          requestId: REQUEST_IDS.pair,
          port: channel.port2,
        } satisfies RenderWorkerRequest,
        [channel.port2], // transfer the render-side port
      );
    },
    reopen(handle) {
      if (!isOpened) return;
      uiStore.getState().beginLoading("open", "opening dataset");
      dataWorker.postMessage({
        kind: "reopen",
        requestId: STREAM_REQUEST_ID,
        handle,
        activeField: store.getState().activeField,
      } satisfies DataStreamRequest);
    },
    setPerfActive(active) {
      dataWorker.postMessage({
        kind: "setPerfActive",
        requestId: STREAM_REQUEST_ID,
        active,
      } satisfies DataStreamRequest);
    },
    dispose() {
      unsubscribeStep();
      unsubscribeActiveField();
      dataWorker.terminate();
    },
  };
}
