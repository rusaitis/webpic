import type { CameraPose, SimulationStore, UiStore } from "@store";
import { makeEl } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";

// Always-on camera HUD pinned bottom-left: a live pose readout + a CSS-3D axis gnomon. Both are
// driven straight from the store pose — the pose is angle-parameterized, so the gnomon is a CSS
// transform, no second renderer or worker round-trip. Hides with the rest of the UI on the toggle.

const RAD_TO_DEG = 180 / Math.PI;

function formatPose(pose: CameraPose): string {
  const [tx, ty, tz] = pose.target;
  const az = (pose.azimuth * RAD_TO_DEG).toFixed(0);
  const el = (pose.elevation * RAD_TO_DEG).toFixed(0);
  const target = `${tx.toFixed(2)}, ${ty.toFixed(2)}, ${tz.toFixed(2)}`;
  return `az ${az}°  el ${el}°  d ${pose.distance.toFixed(2)}  ·  [${target}]`;
}

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

export function installCameraChrome(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const container = makeEl(doc, "div", "webpic-chrome");

  const gnomon = makeEl(doc, "div", "webpic-gnomon");
  gnomon.title = "Camera orientation — X red, Y green, Z blue";
  const scene = makeEl(doc, "div", "webpic-gnomon_scene");
  for (const axis of ["x", "y", "z"] as const) {
    const arm = makeEl(doc, "div", `webpic-gnomon_axis is-${axis}`);
    arm.dataset.axis = axis.toUpperCase();
    scene.appendChild(arm);
  }
  gnomon.appendChild(scene);

  const readout = makeEl(doc, "div", "webpic-readout");
  container.append(gnomon, readout);
  parent.appendChild(container);

  const render = (pose: CameraPose): void => {
    readout.textContent = formatPose(pose);
    scene.style.transform = gnomonTransform(pose);
  };
  render(store.getState().cameraPose);
  const unsubPose = store.subscribe((s) => s.cameraPose, render);

  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
  };
  applyVisible(uiStore.getState().isUiVisible);
  const unsubUi = uiStore.subscribe((s) => s.isUiVisible, applyVisible);

  // The gnomon is independently toggleable (the Scene panel's "Gnomon" control) so it can be hidden
  // once the in-scene 3D axes suffice; the pose readout stays. Driven by the store overlay slice.
  const applyGnomon = (show: boolean): void => {
    gnomon.hidden = !show;
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
