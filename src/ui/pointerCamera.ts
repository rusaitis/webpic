import {
  type AxisView,
  axisViewPose,
  type BoundingSphere,
  DEFAULT_POSE,
  poseForBounds,
  type SimulationStore,
  UNIT_BOX_RADIUS,
} from "@store";
import { installCameraGestures } from "./cameraGestures.ts";
import { createCameraGlide } from "./cameraGlide.ts";
import type { Disposer } from "./controls/index.ts";
import { createShortcutRegistry } from "./shortcuts.ts";
import { createSubscriptions } from "./subscriptions.ts";

// The camera input composer: the glide loop (ui/cameraGlide — momentum, held-key nudges, fly-to
// tweens, cameraMotion) plus the pointer gestures that feed it (ui/cameraGestures), the view
// shortcuts, and the cameraFlyRequest intents other chrome dispatches (gnomon axis snap, Fit view).
// ui → store only; no render import.

// Fit target until non-cube datasets land: the unit render box's bounding sphere.
const FIT_SPHERE: BoundingSphere = { center: [0, 0, 0], radius: UNIT_BOX_RADIUS };

// Tap-to-snap axis views (z-up: Top = +z). Digit 0 / backtick returns to the default 3/4 view.
// Keyed by event.code so the digit row works regardless of layout. null = the home pose.
const AXIS_KEYS: ReadonlyMap<string, AxisView | null> = new Map([
  ["Digit1", "+x"], // front
  ["Digit2", "-x"], // back
  ["Digit3", "+y"], // right
  ["Digit4", "-y"], // left
  ["Digit5", "+z"], // top
  ["Digit6", "-z"], // bottom
  ["Digit0", null],
  ["Backquote", null],
]);

export function installPointerCamera(target: HTMLElement, store: SimulationStore): Disposer {
  const doc = target.ownerDocument;
  const glide = createCameraGlide({ store, doc });
  const disposeGestures = installCameraGestures(target, store, glide);

  // Frame the data (Z / "Fit view"): keep the viewing direction, recenter + back off to fit the
  // unit render box. Resolved here — only this module knows the canvas aspect the fit needs.
  const flyToFit = (): void => {
    const rect = target.getBoundingClientRect();
    const aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1;
    glide.flyTo(poseForBounds(store.getState().cameraPose, FIT_SPHERE, aspect));
  };

  // R reset, Shift+R level horizon, Z fit, O projection, N fly mode, 1–6/0/` axis snaps. The held
  // orbit/dolly/roll keys live in the glide; T (add field lines) belongs to ui/install.
  const shortcuts = createShortcutRegistry(doc);
  shortcuts.register("r", () => glide.flyTo(DEFAULT_POSE));
  shortcuts.register("KeyR", () => glide.flyTo({ ...store.getState().cameraPose, roll: 0 }), {
    modifiers: "shift",
  });
  shortcuts.register("z", flyToFit);
  shortcuts.register("o", () => {
    const state = store.getState();
    state.setProjection(state.projection === "orthographic" ? "perspective" : "orthographic");
  });
  shortcuts.register("n", () => store.getState().toggleFlyMode()); // orbit ⇄ fly (first-person look)
  for (const [code, axis] of AXIS_KEYS) {
    shortcuts.register(code, () =>
      glide.flyTo(axis === null ? DEFAULT_POSE : axisViewPose(axis, store.getState().cameraPose)),
    );
  }

  // Fly-to requests from elsewhere in the ui arrive as store intents — this module owns the camera
  // animation loop, so it consumes (and resolves) them.
  const subscriptions = createSubscriptions();
  subscriptions.on(
    store,
    (s) => s.cameraFlyRequest,
    (request) => {
      if (request === null) return;
      if (request.target.kind === "pose") glide.flyTo(request.target.pose);
      else flyToFit();
      store.getState().requestCameraFly(null); // consume — a repeat of the same view re-fires
    },
  );

  return () => {
    subscriptions.dispose();
    shortcuts.dispose();
    disposeGestures();
    glide.dispose();
  };
}
