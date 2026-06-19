import {
  type AxisView,
  axisViewPose,
  type CameraPose,
  type SimulationStore,
  type UiStore,
} from "@store";
import { makeEl } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";

// Always-on camera gnomon pinned bottom-left: a CSS-3D axis triad driven straight from the store
// pose. The pose is angle-parameterized, so the gnomon is a CSS transform — no second renderer or
// worker round-trip. Hides with the rest of the UI on the toggle, and independently via the bottom
// rail's gnomon control. The ±axis tips are clickable (magviz's ViewHelper discs): a click
// dispatches a cameraFlyRequest intent that ui/pointerCamera eases to — chrome never animates the
// pose itself. The pose readout + view permalink now live in the bottom rail (ui/cameraRail).

// The gnomon shows the world axes as the camera sees them. The arms are a fixed CSS triad — is-x→right,
// is-y→into-screen, is-z→up at rest (the .is-* CSS) — and this shared transform rotates that triad into
// the current view. It's the world→screen rotation of the z-up orbit camera (camera.ts applyPose),
// written straight as matrix3d so it tracks the camera exactly: a rotateX·rotateY Euler form mirrored x/y
// and spun azimuth backwards under z-up. Columns map the arms' scene-space directions (is-x=+x̂,
// is-y=−ẑ, is-z=−ŷ) onto each world axis' screen projection; CSS y is down, so the up component flips.
export function gnomonTransform(pose: CameraPose): string {
  const sa = Math.sin(pose.azimuth);
  const ca = Math.cos(pose.azimuth);
  const se = Math.sin(pose.elevation);
  const ce = Math.cos(pose.elevation);
  // Column-major (det +1, a proper rotation): col1 = world-x dir, −col3 = world-y dir, −col2 = world-z
  // dir, all in CSS coords. screenRight=(−sa,ca,0), screenUp=(−se·ca,−se·sa,ce), screenBack toward viewer.
  const m = [-sa, se * ca, ce * ca, 0, 0, ce, -se, 0, -ca, -se * sa, -ce * sa, 0, 0, 0, 0, 1];
  return `matrix3d(${m.map((v) => v.toFixed(5)).join(", ")})`;
}

// The inverse (= transpose, pure rotation) of gnomonTransform. A tip's transform is
// translate3d(arm tip) · this, so under the scene's rotation R the disc lands at R·tip but keeps a
// screen-facing orientation (R·T·R⁻¹ = T(R·tip)) — otherwise the discs collapse to lines edge-on.
export function gnomonCounterTransform(pose: CameraPose): string {
  const sa = Math.sin(pose.azimuth);
  const ca = Math.cos(pose.azimuth);
  const se = Math.sin(pose.elevation);
  const ce = Math.cos(pose.elevation);
  const m = [-sa, 0, -ca, 0, se * ca, ce, -se * sa, 0, ce * ca, -se, -ce * sa, 0, 0, 0, 0, 1];
  return `matrix3d(${m.map((v) => v.toFixed(5)).join(", ")})`;
}

// The arms' scene-space frame (see gnomonTransform): world +x → CSS +x, world +y → CSS −z (into
// the screen), world +z → CSS −y (CSS y points down). Tip offsets sit at the 24 px arm ends.
const TIP_OFFSET_PX = 24;
const GNOMON_TIPS: readonly {
  readonly view: AxisView;
  readonly cls: string;
  readonly offset: readonly [number, number, number];
}[] = [
  { view: "+x", cls: "is-px", offset: [TIP_OFFSET_PX, 0, 0] },
  { view: "-x", cls: "is-nx", offset: [-TIP_OFFSET_PX, 0, 0] },
  { view: "+y", cls: "is-py", offset: [0, 0, -TIP_OFFSET_PX] },
  { view: "-y", cls: "is-ny", offset: [0, 0, TIP_OFFSET_PX] },
  { view: "+z", cls: "is-pz", offset: [0, -TIP_OFFSET_PX, 0] },
  { view: "-z", cls: "is-nz", offset: [0, TIP_OFFSET_PX, 0] },
];

export function installCameraChrome(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const container = makeEl(doc, "div", "webpic-chrome");

  const gnomon = makeEl(doc, "div", "webpic-gnomon");
  gnomon.title = "Camera orientation — X red, Y green, Z blue. Click a tip to snap the view.";
  const scene = makeEl(doc, "div", "webpic-gnomon_scene");
  for (const axis of ["x", "y", "z"] as const) {
    const arm = makeEl(doc, "div", `webpic-gnomon_axis is-${axis}`);
    arm.dataset.axis = axis.toUpperCase();
    scene.appendChild(arm);
  }
  const tips = GNOMON_TIPS.map((spec) => {
    const tip = makeEl(doc, "div", `webpic-gnomon_tip ${spec.cls}`);
    tip.title = `View from ${spec.view}`;
    tip.addEventListener("click", () => {
      const state = store.getState();
      state.requestCameraFly({ kind: "pose", pose: axisViewPose(spec.view, state.cameraPose) });
    });
    scene.appendChild(tip);
    return { el: tip, offset: spec.offset };
  });
  gnomon.appendChild(scene);

  container.append(gnomon);
  parent.appendChild(container);

  const render = (pose: CameraPose): void => {
    // Hidden chrome/gnomon skips the per-pose matrix3d + tip churn at gesture rate; the show paths
    // below re-render so nothing coasts on a stale pose.
    if (container.hidden || gnomon.hidden) return;
    // Roll is a screen-Z image rotation, so it composes as an outer 2D rotate on the whole triad
    // (tips ride along through preserve-3d). The scene appears to spin opposite the camera bank.
    scene.style.transform =
      pose.roll === 0
        ? gnomonTransform(pose)
        : `rotate(${(-pose.roll).toFixed(5)}rad) ${gnomonTransform(pose)}`;
    const counter = gnomonCounterTransform(pose);
    for (const tip of tips) {
      const [x, y, z] = tip.offset;
      tip.el.style.transform = `translate3d(${x}px, ${y}px, ${z}px) ${counter}`;
    }
  };
  render(store.getState().cameraPose);
  const unsubPose = store.subscribe((s) => s.cameraPose, render);

  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
    if (visible) render(store.getState().cameraPose); // catch up — the pose moved while hidden
  };
  applyVisible(uiStore.getState().isUiVisible);
  const unsubUi = uiStore.subscribe((s) => s.isUiVisible, applyVisible);

  // The gnomon is independently toggleable (the bottom rail's "Gnomon" control) so it can be
  // hidden once the in-scene 3D axes suffice. Driven by the store overlay slice.
  const applyGnomon = (show: boolean): void => {
    gnomon.hidden = !show;
    if (show) render(store.getState().cameraPose); // catch up — the pose moved while hidden
  };
  applyGnomon(store.getState().overlay.showGnomon);
  const unsubGnomon = store.subscribe((s) => s.overlay.showGnomon, applyGnomon);

  return () => {
    unsubPose();
    unsubUi();
    unsubGnomon();
    container.remove();
  };
}
