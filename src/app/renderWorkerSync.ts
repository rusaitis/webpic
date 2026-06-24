import {
  REQUEST_IDS,
  type RenderWorkerRequest,
  type RenderWorkerResponse,
} from "@render/messages.ts";
import {
  type CameraPose,
  type CameraProjection,
  cursorRay,
  focusPoseOnPoint,
  type SimulationStore,
  unitBoxChordMidpoint,
} from "@store";
import { createStoreBridge } from "./storeBridge.ts";

// The cheap store→render-worker control channel (app-only glue: store and render can't import each
// other). Pose, projection, camera-motion, and the diagnostics continuous-measure toggle each ride a
// guarded one-line post; a pick request marches a cursor ray (with a pre-ready geometric fallback) and
// its reply (handlePickResult) places the marker + retargets a focus fly. Gated on `workerReady` via
// the shared store bridge; pose/projection get a ready-time catch-up via flushAll, mirroring layerSync.

export interface RenderWorkerSyncOptions {
  readonly store: SimulationStore;
  readonly worker: Pick<Worker, "postMessage">;
  /** Reads the bootstrap `workerReady` flag — nothing is posted until the worker is live. */
  readonly isReady: () => boolean;
}

export interface RenderWorkerSync {
  /** Replay the live pose (+ a non-default projection) once the worker is ready (catch-up). */
  readonly flushAll: () => void;
  /** Route a worker pick reply: place the marker, and for "focus" retarget the running fly. */
  readonly handlePickResult: (
    message: Extract<RenderWorkerResponse, { kind: "pickResult" }>,
  ) => void;
  readonly dispose: () => void;
}

export function installRenderWorkerSync(opts: RenderWorkerSyncOptions): RenderWorkerSync {
  const { store, worker, isReady } = opts;
  const bridge = createStoreBridge(store, isReady);

  const postPose = (pose: CameraPose): void => {
    worker.postMessage({
      kind: "setCameraPose",
      requestId: REQUEST_IDS.pose,
      pose,
    } satisfies RenderWorkerRequest);
  };
  const postProjection = (projection: CameraProjection): void => {
    worker.postMessage({
      kind: "setProjection",
      requestId: REQUEST_IDS.projection,
      projection,
    } satisfies RenderWorkerRequest);
  };

  // Pose is always present (DEFAULT_POSE) and the worker applied it at init, so this fires only on
  // user-driven changes; the ready catch-up (flushAll) covers a drag during worker init.
  bridge.subscribeWhenReady((state) => state.cameraPose, postPose);

  // Volume-view projection (persp ↔ ortho). Default perspective on both sides, so only user flips post.
  bridge.subscribeWhenReady((state) => state.projection, postProjection);

  // Camera-motion liveness → worker quality tier (gesture = coarse march, fly = crisp animating tier).
  bridge.subscribeWhenReady(
    (state) => state.cameraMotion,
    (motion) => {
      worker.postMessage({
        kind: "setCameraMotion",
        requestId: REQUEST_IDS.motion,
        motion,
      } satisfies RenderWorkerRequest);
    },
  );

  // Diagnostics "Measure" toggle → the worker's continuous-repaint mode for sustained GPU timing.
  bridge.subscribeWhenReady(
    (state) => state.isMeasuringContinuous,
    (continuous) => {
      worker.postMessage({
        kind: "setContinuous",
        requestId: REQUEST_IDS.continuous,
        continuous,
      } satisfies RenderWorkerRequest);
    },
  );

  // Pick-to-place / pick-to-focus: forward the cursor NDC to the worker's opacity-weighted ray march
  // (its pickResult routes through handlePickResult). It runs in BOTH ready states — pre-ready there's
  // no field to weight by, so it falls back to the box-chord midpoint (the same store math ui used for
  // the hit test) — so it's a raw subscription with its own branch, not the plain isReady gate.
  bridge.subscribe(
    (state) => state.pickRequest,
    (request) => {
      if (request === null) return;
      const { ndcX, ndcY, aspect, purpose, focusDistance } = request;
      if (isReady()) {
        worker.postMessage({
          kind: "pickRay",
          requestId: REQUEST_IDS.pick,
          ndcX,
          ndcY,
          purpose,
          // exactOptionalPropertyTypes: forward the field only when the gesture carried it.
          ...(focusDistance !== undefined ? { focusDistance } : {}),
        } satisfies RenderWorkerRequest);
      } else {
        const state = store.getState();
        const ray = cursorRay(
          state.cameraPose,
          ndcX,
          ndcY,
          aspect,
          state.projection === "orthographic",
        );
        const point = unitBoxChordMidpoint(ray.origin, ray.dir, state.worldHalfExtent);
        if (point !== null) {
          state.setPickerPoint(point);
          if (purpose === "focus") {
            state.requestCameraFly({
              kind: "pose",
              pose: focusPoseOnPoint(state.cameraPose, point, focusDistance),
            });
          }
        }
      }
      store.getState().requestPick(null); // consume — same-spot clicks re-fire
    },
  );

  return {
    flushAll() {
      const state = store.getState();
      postPose(state.cameraPose);
      // Catch-up posts a non-default projection only — perspective is the worker's init default.
      if (state.projection !== "perspective") postProjection(state.projection);
    },
    handlePickResult(message) {
      // null = the ray missed the box; ui already handled background double-clicks synchronously.
      if (message.point === null) return;
      // Both purposes move the marker; "focus" retargets the fly ui already started toward the chord
      // midpoint. The echoed gesture-time distance keeps the ×0.7 dolly from compounding against the
      // already-flying pose.
      store.getState().setPickerPoint(message.point);
      if (message.purpose === "focus") {
        const pose = focusPoseOnPoint(
          store.getState().cameraPose,
          message.point,
          message.focusDistance,
        );
        store.getState().requestCameraFly({ kind: "pose", pose });
      }
    },
    dispose() {
      bridge.dispose();
    },
  };
}
