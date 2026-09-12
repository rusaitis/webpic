import { type CameraPose, DEFAULT_POSE } from "@schema/camera.ts";
import {
  HANDLE_KNOB_SCALE,
  HANDLE_OFFSET_SCALE,
  type HandleAxis,
  horizontalDragAllowed,
  horizontalDragAxis,
  MARKER_SPHERE_RADIUS,
  type MarkerPart,
  markerCoreScale,
  verticalDragAllowed,
} from "@schema/marker.ts";
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  type Texture,
} from "three";
import { finishCanvasTexture } from "../canvasTexture.ts";
import type { MarkerConfig } from "../messages.ts";

// The draggable point-picker marker scene (worker-owned, composited last with the volume camera, like
// the grid overlay). A z-up selection marker: an accent core
// sphere, a billboarded two-tone outline ring (reads on any background), ↕ (z) and ↔ (x|y) drag-handle
// knobs that gate on camera elevation, and a drop line + crosshair guide to the equatorial plane.
//
// The core (+ its ring/handle children) scales by the zoom-aware factor so its apparent size holds at
// any dolly; the guides stay world-fixed. The geometry constants + gating live in @schema/marker so the
// main-thread hit-test (store/marker) projects exactly these positions. Hover/pulse/active easing runs
// in tick() — the worker keeps painting while it returns true, then the on-demand loop goes idle.

export interface MarkerScene {
  readonly scene: Scene;
  setPoint(point: readonly [number, number, number] | null): void;
  setState(hovered: MarkerPart, active: boolean): void;
  updateForPose(pose: CameraPose, isOrthographic: boolean): void;
  tick(dt: number): boolean; // dt seconds; true while still easing toward targets
  dispose(): void;
}

// Local (pre-zoom) sizes, in core-child units; the core's zoom scale multiplies them in world.
const OUTLINE_SCALE = 3.2; // ring sprite size ÷ sphere radius
const RING_BASE = MARKER_SPHERE_RADIUS * OUTLINE_SCALE;
const KNOB_BASE = MARKER_SPHERE_RADIUS * HANDLE_KNOB_SCALE;
const HANDLE_OFFSET = MARKER_SPHERE_RADIUS * HANDLE_OFFSET_SCALE; // stem length / knob distance

const HANDLE_RENDER_ORDER = 999; // draw the affordances on top, like a transform gizmo
const HANDLE_IDLE_OPACITY = 0.4; // ↕ knob/stem opacity at rest
const HHANDLE_IDLE_OPACITY = 0.3; // ↔ knob/stem opacity at rest (subtler)
const GUIDE_HALF = 0.04; // crosshair arm half-length, world units

// Easing rates (1/s) and magnitudes for the selection feel.
const HOVER_RATE = 14;
const PULSE_RATE = 7;
const ACTIVE_RATE = 12;
const HANDLE_RATE = 14;
const HOVER_SCALE = 0.15; // extra ring scale at full hover
const HOVER_BRIGHTEN = 0.4; // core lerp-to-white at full hover
const PULSE_SCALE = 0.35; // extra ring scale at the click-pulse peak
const ACTIVE_HOLD_FRACTION = 0.5; // held ring expansion ÷ pulse peak while dragging
const HANDLE_HOVER_GROW = 0.25; // extra knob scale at full hover/active
const DT_CLAMP = 0.1; // cap dt so a tab-switch stall doesn't snap the anim
const SETTLE_EPS = 1e-3; // |value − target| below this counts as settled

// Frame-rate-independent exponential approach factor for a decay rate (dt pre-clamped).
function easeStep(dt: number, rate: number): number {
  return 1 - Math.exp(-dt * rate);
}

function rgbColor(c: readonly [number, number, number, number]): Color {
  return new Color(c[0], c[1], c[2]);
}

// Paint a two-tone outline ring (light outer band beside a dark inner band) into an OffscreenCanvas
// (no `document` in the worker — mirrors overlayScene). Returns null where 2D canvas is unavailable.
function paintRingTexture(): Texture | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const size = 256;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const cx = size / 2;
  ctx.lineWidth = 16;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.arc(cx, cx, 102, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.beginPath();
  ctx.arc(cx, cx, 86, 0, Math.PI * 2);
  ctx.stroke();
  return finishCanvasTexture(canvas);
}

// Paint a drag-handle knob: a light disc carrying a bold dark double-chevron (↕ when vertical, ↔ when
// not) — the "drag along this axis" affordance.
function paintKnobTexture(vertical: boolean): Texture | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const size = 128;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const c = size / 2;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.beginPath();
  ctx.arc(c, c, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.95)";
  ctx.lineWidth = 14;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (vertical) {
    ctx.moveTo(c - 24, 52);
    ctx.lineTo(c, 24);
    ctx.lineTo(c + 24, 52); // up chevron
    ctx.moveTo(c - 24, 76);
    ctx.lineTo(c, 104);
    ctx.lineTo(c + 24, 76); // down chevron
  } else {
    ctx.moveTo(52, c - 24);
    ctx.lineTo(24, c);
    ctx.lineTo(52, c + 24); // left chevron
    ctx.moveTo(76, c - 24);
    ctx.lineTo(104, c);
    ctx.lineTo(76, c + 24); // right chevron
  }
  ctx.stroke();
  return finishCanvasTexture(canvas);
}

function spriteMaterial(map: Texture | null, opacity: number): SpriteMaterial {
  return new SpriteMaterial({
    ...(map !== null ? { map } : {}),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    opacity,
  });
}

function lineMaterial(color: Color, opacity: number): LineBasicMaterial {
  return new LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
  });
}

function planeZForPosition(position: MarkerConfig["planePosition"]): number {
  return position === "min" ? -0.5 : position === "max" ? 0.5 : 0;
}

export function createMarkerScene(config: MarkerConfig): MarkerScene {
  const scene = new Scene();
  const textures: Texture[] = [];
  const guidePlaneZ = planeZForPosition(config.planePosition);
  const coreBaseColor = rgbColor(config.coreColor);
  const white = new Color(0xffffff);

  // Core sphere — the parent the ring + handles ride, scaled by the zoom factor.
  const coreGeom = new SphereGeometry(MARKER_SPHERE_RADIUS, 16, 16);
  const coreMat = new MeshBasicMaterial({ color: coreBaseColor.clone(), transparent: true });
  const core = new Mesh(coreGeom, coreMat);
  core.visible = false;
  scene.add(core);

  // Two-tone outline ring (billboard).
  const ringTex = paintRingTexture();
  if (ringTex !== null) textures.push(ringTex);
  const ringMat = spriteMaterial(ringTex, 1);
  const ring = new Sprite(ringMat);
  ring.scale.set(RING_BASE, RING_BASE, 1);
  ring.renderOrder = HANDLE_RENDER_ORDER;
  core.add(ring);

  // ↕ (z) handle: stem + knob.
  const vStemGeom = new BufferGeometry();
  vStemGeom.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0, 0, HANDLE_OFFSET], 3));
  const vStemMat = lineMaterial(white.clone(), HANDLE_IDLE_OPACITY);
  const vStem = new Line(vStemGeom, vStemMat);
  vStem.frustumCulled = false;
  vStem.renderOrder = HANDLE_RENDER_ORDER;
  core.add(vStem);
  const vKnobTex = paintKnobTexture(true);
  if (vKnobTex !== null) textures.push(vKnobTex);
  const vKnobMat = spriteMaterial(vKnobTex, HANDLE_IDLE_OPACITY);
  const vKnob = new Sprite(vKnobMat);
  vKnob.scale.set(KNOB_BASE, KNOB_BASE, 1);
  vKnob.position.set(0, 0, HANDLE_OFFSET);
  vKnob.renderOrder = HANDLE_RENDER_ORDER;
  core.add(vKnob);

  // ↔ (x|y) handle: stem + knob, reoriented per pose; starts along +x, hidden.
  const hStemGeom = new BufferGeometry();
  hStemGeom.setAttribute("position", new Float32BufferAttribute([0, 0, 0, HANDLE_OFFSET, 0, 0], 3));
  const hStemMat = lineMaterial(white.clone(), HHANDLE_IDLE_OPACITY);
  const hStem = new Line(hStemGeom, hStemMat);
  hStem.frustumCulled = false;
  hStem.renderOrder = HANDLE_RENDER_ORDER;
  hStem.visible = false;
  core.add(hStem);
  const hKnobTex = paintKnobTexture(false);
  if (hKnobTex !== null) textures.push(hKnobTex);
  const hKnobMat = spriteMaterial(hKnobTex, HHANDLE_IDLE_OPACITY);
  const hKnob = new Sprite(hKnobMat);
  hKnob.scale.set(KNOB_BASE, KNOB_BASE, 1);
  hKnob.position.set(HANDLE_OFFSET, 0, 0);
  hKnob.renderOrder = HANDLE_RENDER_ORDER;
  hKnob.visible = false;
  core.add(hKnob);

  // Guides (world-fixed, not under the scaled core): drop line to the equatorial plane + a crosshair.
  const guides = new Group();
  guides.visible = false;
  const guideColor = rgbColor(config.guideColor);
  const guideOpacity = config.guideColor[3];
  const dropGeom = new BufferGeometry();
  dropGeom.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
  const dropMat = lineMaterial(guideColor.clone(), guideOpacity);
  const dropLine = new Line(dropGeom, dropMat);
  dropLine.frustumCulled = false;
  guides.add(dropLine);
  const crossGeom = new BufferGeometry();
  crossGeom.setAttribute("position", new Float32BufferAttribute(new Float32Array(12), 3));
  const crossMat = lineMaterial(guideColor.clone(), guideOpacity);
  const cross = new LineSegments(crossGeom, crossMat);
  cross.frustumCulled = false;
  guides.add(cross);
  scene.add(guides);

  // Eased animation state. Gates init to the defaults (vertical enabled, horizontal hidden); the
  // first updateForPose sets the live targets, so a mid-range pose shows no startup animation.
  let pose: CameraPose = DEFAULT_POSE;
  let isOrthographic = false;
  let point: [number, number, number] | null = null;
  let hadPoint = false;
  let wasActive = false;
  let hAxis: HandleAxis | null = null;
  let hover = 0;
  let hoverT = 0;
  let pulse = 0;
  let active = 0;
  let activeT = 0;
  let hHover = 0;
  let hHoverT = 0;
  let hActive = 0;
  let hActiveT = 0;
  let vKnobHover = 0;
  let vKnobHoverT = 0;
  let vKnobActive = 0;
  let vKnobActiveT = 0;
  let vGate = 1;
  let vGateT = 1;
  let hGate = 0;
  let hGateT = 0;

  const applyCoreScale = (): void => {
    if (point === null) return;
    core.scale.setScalar(markerCoreScale(pose, point, isOrthographic));
  };

  const updateGuides = (): void => {
    if (point === null) return;
    const [px, py, pz] = point;
    const drop = dropGeom.getAttribute("position");
    drop.setXYZ(0, px, py, pz);
    drop.setXYZ(1, px, py, guidePlaneZ);
    drop.needsUpdate = true;
    const arms = crossGeom.getAttribute("position");
    arms.setXYZ(0, px - GUIDE_HALF, py, guidePlaneZ);
    arms.setXYZ(1, px + GUIDE_HALF, py, guidePlaneZ);
    arms.setXYZ(2, px, py - GUIDE_HALF, guidePlaneZ);
    arms.setXYZ(3, px, py + GUIDE_HALF, guidePlaneZ);
    arms.needsUpdate = true;
  };

  return {
    scene,
    setPoint(next) {
      if (next === null) {
        point = null;
        core.visible = false;
        guides.visible = false;
        hadPoint = false;
        return;
      }
      // Hover/active updates re-send the unchanged point (one message carries all three) — only a
      // real move is a placement, else every hover edge would fire a placement pulse.
      const moved =
        point === null || point[0] !== next[0] || point[1] !== next[1] || point[2] !== next[2];
      core.visible = true;
      guides.visible = true;
      if (moved) {
        point = [next[0], next[1], next[2]];
        core.position.set(next[0], next[1], next[2]);
        applyCoreScale();
        updateGuides();
        // A placement (point moved while not dragging) re-pulses; the first appearance does not.
        if (!wasActive && hadPoint) pulse = 1;
      }
      hadPoint = true;
    },
    setState(hovered, isActive) {
      hoverT = hovered === "core" ? 1 : 0;
      vKnobHoverT = hovered === "vertical" ? 1 : 0;
      hHoverT = hovered === "horizontal" ? 1 : 0;
      activeT = isActive && hovered === "core" ? 1 : 0;
      vKnobActiveT = isActive && hovered === "vertical" ? 1 : 0;
      hActiveT = isActive && hovered === "horizontal" ? 1 : 0;
      if (isActive && !wasActive) pulse = 1; // grab pulse
      wasActive = isActive;
    },
    updateForPose(nextPose, ortho) {
      pose = nextPose;
      isOrthographic = ortho;
      applyCoreScale();
      vGateT = verticalDragAllowed(pose) ? 1 : 0;
      const axis = horizontalDragAllowed(pose) ? null : horizontalDragAxis(pose);
      hGateT = axis !== null ? 1 : 0;
      if (axis !== null && axis !== hAxis) {
        const pos = hStemGeom.getAttribute("position");
        if (axis === "x") {
          pos.setXYZ(1, HANDLE_OFFSET, 0, 0);
          hKnob.position.set(HANDLE_OFFSET, 0, 0);
        } else {
          pos.setXYZ(1, 0, HANDLE_OFFSET, 0);
          hKnob.position.set(0, HANDLE_OFFSET, 0);
        }
        pos.needsUpdate = true;
        hAxis = axis;
      }
    },
    tick(dt) {
      const dtc = Math.min(dt, DT_CLAMP);
      const step = easeStep(dtc, HOVER_RATE);
      const stepActive = easeStep(dtc, ACTIVE_RATE);
      const stepPulse = easeStep(dtc, PULSE_RATE);
      const stepHandle = easeStep(dtc, HANDLE_RATE);
      hover += (hoverT - hover) * step;
      pulse += (0 - pulse) * stepPulse;
      active += (activeT - active) * stepActive;
      vKnobHover += (vKnobHoverT - vKnobHover) * stepHandle;
      vKnobActive += (vKnobActiveT - vKnobActive) * stepHandle;
      vGate += (vGateT - vGate) * stepHandle;
      hHover += (hHoverT - hHover) * stepHandle;
      hActive += (hActiveT - hActive) * stepHandle;
      hGate += (hGateT - hGate) * stepHandle;

      const expand = pulse + ACTIVE_HOLD_FRACTION * active;
      const ringScale = RING_BASE * (1 + HOVER_SCALE * hover + PULSE_SCALE * expand);
      ring.scale.set(ringScale, ringScale, 1);
      const brighten = Math.min(1, HOVER_BRIGHTEN * hover + 0.5 * PULSE_SCALE * expand);
      coreMat.color.copy(coreBaseColor).lerp(white, brighten);

      const vLit = Math.max(vKnobHover, vKnobActive);
      const vOp = (HANDLE_IDLE_OPACITY + (1 - HANDLE_IDLE_OPACITY) * vLit) * vGate;
      vKnobMat.opacity = vOp;
      vStemMat.opacity = vOp;
      const vks = KNOB_BASE * (1 + HANDLE_HOVER_GROW * vLit);
      vKnob.scale.set(vks, vks, 1);
      const vShown = vGate > 0.02;
      vKnob.visible = vShown;
      vStem.visible = vShown;

      const hLit = Math.max(hHover, hActive);
      const hOp = (HHANDLE_IDLE_OPACITY + (1 - HHANDLE_IDLE_OPACITY) * hLit) * hGate;
      hKnobMat.opacity = hOp;
      hStemMat.opacity = hOp;
      const hks = KNOB_BASE * (1 + HANDLE_HOVER_GROW * hLit);
      hKnob.scale.set(hks, hks, 1);
      const hShown = hGate > 0.02;
      hKnob.visible = hShown;
      hStem.visible = hShown;

      return (
        Math.abs(hoverT - hover) > SETTLE_EPS ||
        pulse > SETTLE_EPS ||
        Math.abs(activeT - active) > SETTLE_EPS ||
        Math.abs(vKnobHoverT - vKnobHover) > SETTLE_EPS ||
        Math.abs(vKnobActiveT - vKnobActive) > SETTLE_EPS ||
        Math.abs(vGateT - vGate) > SETTLE_EPS ||
        Math.abs(hHoverT - hHover) > SETTLE_EPS ||
        Math.abs(hActiveT - hActive) > SETTLE_EPS ||
        Math.abs(hGateT - hGate) > SETTLE_EPS
      );
    },
    dispose() {
      coreGeom.dispose();
      coreMat.dispose();
      ringMat.dispose();
      vStemGeom.dispose();
      vStemMat.dispose();
      vKnobMat.dispose();
      hStemGeom.dispose();
      hStemMat.dispose();
      hKnobMat.dispose();
      dropGeom.dispose();
      dropMat.dispose();
      crossGeom.dispose();
      crossMat.dispose();
      for (const tex of textures) tex.dispose();
    },
  };
}
