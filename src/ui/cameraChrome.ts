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

// World axes seen from the camera = the inverse of the camera orientation. With fixed world-up the
// camera is rotateY(azimuth)·rotateX(elevation), so the gnomon (the inverse) is rotateX(-el)·rotateY(-az).
function gnomonTransform(pose: CameraPose): string {
  const x = (-pose.elevation * RAD_TO_DEG).toFixed(2);
  const y = (-pose.azimuth * RAD_TO_DEG).toFixed(2);
  return `rotateX(${x}deg) rotateY(${y}deg)`;
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

  return () => {
    unsubPose();
    unsubUi();
    container.remove();
  };
}
