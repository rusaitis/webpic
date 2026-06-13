import type { RenderWorkerRequest, RenderWorkerResponse } from "@render";
import { cursorRay, focusPoseOnPoint, type SimulationStore, unitBoxChordMidpoint } from "@store";

// The cheap store→render-worker control channel (app-only glue: store and render can't import each
// other). Pose, projection, camera-motion, and the diagnostics continuous-measure toggle each ride a
// guarded one-line post; a pick request marches a cursor ray (with a pre-ready geometric fallback) and
// its reply (handlePickResult) places the marker + retargets a focus fly. Gated on `workerReady`;
// pose/projection get a ready-time catch-up via flushAll, mirroring layerSync.

// Disjoint request ids per posting module (worker error echoes use them); app/main.ts owns init (1).
const PROJECTION_REQUEST_ID = 2;
const POSE_REQUEST_ID = 3;
const CONTINUOUS_REQUEST_ID = 4;
const MOTION_REQUEST_ID = 8;
const PICK_REQUEST_ID = 10;

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

  // Pose is always present (DEFAULT_POSE) and the worker applied it at init, so this fires only on
  // user-driven changes; the ready catch-up (flushAll) covers a drag during worker init.
  const unsubscribePose = store.subscribe(
    (state) => state.cameraPose,
    (pose) => {
      if (!isReady()) return;
      worker.postMessage({
        kind: "setCameraPose",
        requestId: POSE_REQUEST_ID,
        pose,
      } satisfies RenderWorkerRequest);
    },
  );

  // Volume-view projection (persp ↔ ortho). Default perspective on both sides, so only user flips post.
  const unsubscribeProjection = store.subscribe(
    (state) => state.projection,
    (projection) => {
      if (!isReady()) return;
      worker.postMessage({
        kind: "setProjection",
        requestId: PROJECTION_REQUEST_ID,
        projection,
      } satisfies RenderWorkerRequest);
    },
  );

  // Camera-motion liveness → worker quality tier (gesture = coarse march, fly = crisp animating tier).
  const unsubscribeMotion = store.subscribe(
    (state) => state.cameraMotion,
    (motion) => {
      if (!isReady()) return;
      worker.postMessage({
        kind: "setCameraMotion",
        requestId: MOTION_REQUEST_ID,
        motion,
      } satisfies RenderWorkerRequest);
    },
  );

  // Diagnostics "Measure" toggle → the worker's continuous-repaint mode for sustained GPU timing.
  const unsubscribeContinuous = store.subscribe(
    (state) => state.isMeasuringContinuous,
    (continuous) => {
      if (!isReady()) return;
      worker.postMessage({
        kind: "setContinuous",
        requestId: CONTINUOUS_REQUEST_ID,
        continuous,
      } satisfies RenderWorkerRequest);
    },
  );

  // Pick-to-place / pick-to-focus: forward the cursor NDC to the worker's opacity-weighted ray march
  // (its pickResult routes through handlePickResult). Pre-ready there's no field to weight by, so fall
  // back to the box-chord midpoint (the same store math ui used for the hit test) — the gesture still
  // places/focuses, just geometrically.
  const unsubscribePick = store.subscribe(
    (state) => state.pickRequest,
    (request) => {
      if (request === null) return;
      const { ndcX, ndcY, aspect, purpose, focusDistance } = request;
      if (isReady()) {
        worker.postMessage({
          kind: "pickRay",
          requestId: PICK_REQUEST_ID,
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
      worker.postMessage({
        kind: "setCameraPose",
        requestId: POSE_REQUEST_ID,
        pose: state.cameraPose,
      } satisfies RenderWorkerRequest);
      if (state.projection !== "perspective") {
        worker.postMessage({
          kind: "setProjection",
          requestId: PROJECTION_REQUEST_ID,
          projection: state.projection,
        } satisfies RenderWorkerRequest);
      }
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
      unsubscribePose();
      unsubscribeProjection();
      unsubscribeMotion();
      unsubscribeContinuous();
      unsubscribePick();
    },
  };
}
