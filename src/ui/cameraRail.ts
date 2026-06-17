import {
  type CameraPose,
  type CameraProjection,
  formatPoseParam,
  type SimulationStore,
  type UiStore,
} from "@store";
import { makeEl } from "./controls/dom.ts";
import type { Disposer } from "./controls/index.ts";

// Centered bottom button rail (magviz's bottom-cluster, cleaned up to webpic's structure): subtle
// icon toggles for the gnomon, orbit/fly mode, and projection, plus an icon-only coordinate button
// (copies the ?pose= permalink, full pose in its tooltip) and a help button. ui → store only — every
// button dispatches a typed intent or reads a slice; no render import. "Gnomon-aware": it reserves
// the bottom-left gnomon's footprint (the has-gnomon inset) so the centered cluster never slides under
// it. Hides with the global UI toggle, like ui/cameraChrome.

const RAD_TO_DEG = 180 / Math.PI;
// Banking under ~0.5° reads as 0° and clutters the readout; hide it until the view is actually rolled.
const ROLL_READOUT_EPSILON = 0.0087;

// Full pose, human-readable — the coordinate button's tooltip (moved here from the old bottom-left
// readout; projection adds an "ortho" suffix so a copied link's mode is legible at a glance).
function formatPose(pose: CameraPose, orthographic: boolean): string {
  const [tx, ty, tz] = pose.target;
  const az = (pose.azimuth * RAD_TO_DEG).toFixed(0);
  const el = (pose.elevation * RAD_TO_DEG).toFixed(0);
  const roll =
    Math.abs(pose.roll) > ROLL_READOUT_EPSILON
      ? `  roll ${(pose.roll * RAD_TO_DEG).toFixed(0)}°`
      : "";
  const target = `${tx.toFixed(2)}, ${ty.toFixed(2)}, ${tz.toFixed(2)}`;
  const suffix = orthographic ? "  ·  ortho" : "";
  return `az ${az}°  el ${el}°  d ${pose.distance.toFixed(2)}${roll}  ·  [${target}]${suffix}`;
}

// 16×16 inline SVGs (no icon-font dep). `stroke: currentColor; fill: none` come from the rail CSS, so
// the whole button tints together; per-icon fills opt back in where a glyph wants a solid mark.
const ICON = {
  gnomon: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13h10M3 13V3M3 13l4.5-3.5"/></svg>`,
  orbit: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.8-4.1"/><path d="M13.6 2.6V6H10.2"/></svg>`,
  fly: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14.5 1.5 1.8 6.9l4.9 1.6 1.6 4.9z"/><path d="M14.5 1.5 6.7 8.5"/></svg>`,
  perspective: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7.7 2 13.5 4.2v6L7.7 12.4 2 10.2v-6z"/><path d="M7.7 2v6.2l5.8-2M7.7 8.2 2 6"/></svg>`,
  ortho: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5h8v8h-8z"/><path d="M5.5 5.5V2.5h8v8h-3"/></svg>`,
  crosshair: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.3"/><path d="M8 1.5v3.2M8 11.3v3.2M1.5 8h3.2M11.3 8h3.2"/></svg>`,
  help: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.7 1.8c-.7.4-1 .8-1 1.5"/><circle cx="7.9" cy="12" r=".55" fill="currentColor" stroke="none"/></svg>`,
} as const;

export function installCameraRail(
  parent: HTMLElement,
  store: SimulationStore,
  uiStore: UiStore,
): Disposer {
  const doc = parent.ownerDocument;
  const container = makeEl(doc, "div", "webpic-rail");
  container.setAttribute("role", "toolbar");
  container.setAttribute("aria-label", "View controls");

  const makeButton = (control: string, extra: string, icon: string): HTMLButtonElement => {
    const btn = makeEl(doc, "button", extra ? `webpic-rail_btn ${extra}` : "webpic-rail_btn");
    btn.type = "button";
    btn.dataset.control = control;
    btn.innerHTML = icon;
    return btn;
  };

  const gnomonBtn = makeButton("gnomon", "", ICON.gnomon);
  const flyBtn = makeButton("fly", "", ICON.orbit);
  const projBtn = makeButton("projection", "", ICON.perspective);
  const coordBtn = makeButton("coord", "webpic-rail_coord", ICON.crosshair);
  const helpBtn = makeButton("help", "", ICON.help);
  helpBtn.title = "Keyboard shortcuts (? / H)";

  gnomonBtn.addEventListener("click", () => {
    const state = store.getState();
    state.setOverlayShowGnomon(!state.overlay.showGnomon);
  });
  flyBtn.addEventListener("click", () => store.getState().toggleFlyMode());
  projBtn.addEventListener("click", () => {
    const state = store.getState();
    state.setProjection(state.projection === "orthographic" ? "perspective" : "orthographic");
  });
  helpBtn.addEventListener("click", () => uiStore.getState().toggleHelp());

  // Click-to-copy permalink: the current pose (+ projection) as a ?pose= URL. Clipboard is undefined
  // on insecure origins — the click is then a no-op. The brief is-copied tint is the only feedback.
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const onCoordClick = (): void => {
    const view = doc.defaultView;
    const clipboard = view?.navigator.clipboard;
    if (view === null || clipboard === undefined) return;
    const url = new URL(view.location.href);
    url.searchParams.set("pose", formatPoseParam(store.getState().cameraPose));
    // "this view" includes the projection — an ortho view must not reopen as perspective.
    if (store.getState().projection === "orthographic") url.searchParams.set("proj", "ortho");
    else url.searchParams.delete("proj");
    void clipboard
      .writeText(url.toString())
      .then(() => {
        coordBtn.classList.add("is-copied");
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => coordBtn.classList.remove("is-copied"), 1200);
      })
      .catch(() => {
        // NotAllowedError (focus loss, permissions) — no copied flash, nothing else to undo.
      });
  };
  coordBtn.addEventListener("click", onCoordClick);

  container.append(gnomonBtn, flyBtn, projBtn, coordBtn, helpBtn);
  parent.appendChild(container);

  // Reflect store state onto the toggles: aria-pressed for assistive tech + styling, a swapped icon
  // and tooltip for the two mode toggles, and the has-gnomon inset that keeps the cluster centered.
  const applyGnomon = (show: boolean): void => {
    gnomonBtn.setAttribute("aria-pressed", String(show));
    gnomonBtn.title = show ? "Hide orientation gnomon" : "Show orientation gnomon";
    container.classList.toggle("has-gnomon", show);
  };
  const applyFly = (fly: boolean): void => {
    flyBtn.setAttribute("aria-pressed", String(fly));
    flyBtn.innerHTML = fly ? ICON.fly : ICON.orbit;
    flyBtn.title = fly
      ? "Fly mode — A/D/Q/E look, W/S walk · click or N to orbit"
      : "Orbit mode — click or N for fly (first-person look)";
  };
  const applyProjection = (projection: CameraProjection): void => {
    const ortho = projection === "orthographic";
    projBtn.setAttribute("aria-pressed", String(ortho));
    projBtn.innerHTML = ortho ? ICON.ortho : ICON.perspective;
    projBtn.title = ortho
      ? "Orthographic — click or O for perspective"
      : "Perspective — click or O for orthographic";
  };
  const applyCoord = (pose: CameraPose): void => {
    if (container.hidden) return; // skip the per-frame string build while hidden; catch up on show
    const ortho = store.getState().projection === "orthographic";
    coordBtn.title = `${formatPose(pose, ortho)} — click to copy a link to this view`;
  };
  const applyVisible = (visible: boolean): void => {
    container.hidden = !visible;
    if (visible) applyCoord(store.getState().cameraPose); // catch up — the pose moved while hidden
  };

  applyGnomon(store.getState().overlay.showGnomon);
  applyFly(store.getState().isFlyMode);
  applyProjection(store.getState().projection);
  applyVisible(uiStore.getState().isUiVisible);

  const unsubs = [
    store.subscribe((s) => s.overlay.showGnomon, applyGnomon),
    store.subscribe((s) => s.isFlyMode, applyFly),
    store.subscribe(
      (s) => s.projection,
      (projection) => {
        applyProjection(projection);
        applyCoord(store.getState().cameraPose); // the ortho suffix on the coord tooltip follows
      },
    ),
    store.subscribe((s) => s.cameraPose, applyCoord),
    uiStore.subscribe((s) => s.isUiVisible, applyVisible),
  ];

  return () => {
    for (const unsub of unsubs) unsub();
    clearTimeout(copiedTimer);
    container.remove();
  };
}
