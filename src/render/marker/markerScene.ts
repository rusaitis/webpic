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
import type { Vec3 } from "@schema/types.ts";
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
import { createDisposableBag } from "../disposableBag.ts";
import type { MarkerConfig } from "../messages.ts";
import { createEasedChannels } from "./easedChannels.ts";

// The draggable point-picker marker scene (worker-owned, composited last with the volume camera):
// an accent core sphere, a billboarded two-tone outline ring that reads on any background, ↕ (z) and
// ↔ (x|y) drag-handle knobs gated on camera elevation, and a guide to the equatorial plane. The core
// scales by the zoom-aware factor so its apparent size holds at any dolly; the guides stay
// world-fixed. Geometry constants + gating live in @schema/marker, so the main-thread hit-test
// (store/interaction/marker) projects exactly these positions.

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
const HORIZONTAL_HANDLE_IDLE_OPACITY = 0.3; // ↔ knob/stem opacity at rest (subtler)
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

// Both drag handles paint the same way: opacity ramps from idle to full as the handle lights up,
// the knob grows with it, and the whole pair fades out with its gate (the pose said this axis is not
// draggable). Only the idle opacity and the objects differ.
function applyHandle(handle: {
  readonly lit: number;
  readonly gate: number;
  readonly idleOpacity: number;
  readonly knob: Sprite;
  readonly knobMaterial: SpriteMaterial;
  readonly stem: Line;
  readonly stemMaterial: LineBasicMaterial;
}): void {
  const opacity = (handle.idleOpacity + (1 - handle.idleOpacity) * handle.lit) * handle.gate;
  handle.knobMaterial.opacity = opacity;
  handle.stemMaterial.opacity = opacity;
  const knobScale = KNOB_BASE * (1 + HANDLE_HOVER_GROW * handle.lit);
  handle.knob.scale.set(knobScale, knobScale, 1);
  const isShown = handle.gate > 0.02; // fully faded reads as gone; skip the draw
  handle.knob.visible = isShown;
  handle.stem.visible = isShown;
}

// One drag handle's objects — what applyHandle animates and what dispose reclaims.
interface Handle {
  readonly stemGeometry: BufferGeometry;
  readonly stemMaterial: LineBasicMaterial;
  readonly stem: Line;
  readonly knobMaterial: SpriteMaterial;
  readonly knob: Sprite;
}

export function createMarkerScene(config: MarkerConfig): MarkerScene {
  const scene = new Scene();
  const bag = createDisposableBag();
  const guidePlaneZ = planeZForPosition(config.planePosition);
  const coreBaseColor = rgbColor(config.coreColor);
  const white = new Color(0xffffff);

  // Core sphere — the parent the ring + handles ride, scaled by the zoom factor.
  const coreGeometry = bag.add(new SphereGeometry(MARKER_SPHERE_RADIUS, 16, 16));
  const coreMaterial = bag.add(
    new MeshBasicMaterial({ color: coreBaseColor.clone(), transparent: true }),
  );
  const core = new Mesh(coreGeometry, coreMaterial);
  core.visible = false;
  scene.add(core);

  // Two-tone outline ring (billboard).
  const ringTexture = paintRingTexture();
  if (ringTexture !== null) bag.add(ringTexture);
  const ringMaterial = bag.add(spriteMaterial(ringTexture, 1));
  const ring = new Sprite(ringMaterial);
  ring.scale.set(RING_BASE, RING_BASE, 1);
  ring.renderOrder = HANDLE_RENDER_ORDER;
  core.add(ring);

  // The two drag handles are one shape: a stem from the core out to `tip` and a knob sprite sitting
  // on it. Only the tip, the idle opacity, the knob artwork and the initial visibility differ.
  const makeHandle = (tip: Vec3, idleOpacity: number, isVertical: boolean): Handle => {
    const stemGeometry = bag.add(new BufferGeometry());
    stemGeometry.setAttribute(
      "position",
      new Float32BufferAttribute([0, 0, 0, tip[0], tip[1], tip[2]], 3),
    );
    const stemMaterial = lineMaterial(white.clone(), idleOpacity);
    const stem = new Line(stemGeometry, stemMaterial);
    stem.frustumCulled = false;
    stem.renderOrder = HANDLE_RENDER_ORDER;
    stem.visible = isVertical;
    core.add(stem);

    const knobTexture = paintKnobTexture(isVertical);
    if (knobTexture !== null) bag.add(knobTexture);
    const knobMaterial = bag.add(spriteMaterial(knobTexture, idleOpacity));
    const knob = new Sprite(knobMaterial);
    knob.scale.set(KNOB_BASE, KNOB_BASE, 1);
    knob.position.set(tip[0], tip[1], tip[2]);
    knob.renderOrder = HANDLE_RENDER_ORDER;
    knob.visible = isVertical;
    core.add(knob);

    return { stemGeometry, stemMaterial, stem, knobMaterial, knob };
  };

  // ↕ (z) handle: stem + knob. ↔ (x|y): the same, reoriented per pose — starts along +x, hidden.
  const vertical = makeHandle([0, 0, HANDLE_OFFSET], HANDLE_IDLE_OPACITY, true);
  const horizontal = makeHandle([HANDLE_OFFSET, 0, 0], HORIZONTAL_HANDLE_IDLE_OPACITY, false);

  // Guides (world-fixed, not under the scaled core): drop line to the equatorial plane + a crosshair.
  const guides = new Group();
  guides.visible = false;
  const guideColor = rgbColor(config.guideColor);
  const guideOpacity = config.guideColor[3];
  const dropGeometry = bag.add(new BufferGeometry());
  dropGeometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
  const dropMaterial = bag.add(lineMaterial(guideColor.clone(), guideOpacity));
  const dropLine = new Line(dropGeometry, dropMaterial);
  dropLine.frustumCulled = false;
  guides.add(dropLine);
  const crossGeometry = bag.add(new BufferGeometry());
  crossGeometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(12), 3));
  const crossMaterial = bag.add(lineMaterial(guideColor.clone(), guideOpacity));
  const cross = new LineSegments(crossGeometry, crossMaterial);
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
  // Vertical enabled, horizontal hidden: the first updateForPose sets the live targets, so a
  // mid-range pose shows no startup animation.
  const eased = createEasedChannels({
    hover: { rate: HOVER_RATE },
    pulse: { rate: PULSE_RATE },
    active: { rate: ACTIVE_RATE },
    verticalKnobHover: { rate: HANDLE_RATE },
    verticalKnobActive: { rate: HANDLE_RATE },
    verticalGate: { rate: HANDLE_RATE, initial: 1 },
    horizontalHover: { rate: HANDLE_RATE },
    horizontalActive: { rate: HANDLE_RATE },
    horizontalGate: { rate: HANDLE_RATE },
  });

  const applyCoreScale = (): void => {
    if (point === null) return;
    core.scale.setScalar(markerCoreScale(pose, point, isOrthographic));
  };

  const updateGuides = (): void => {
    if (point === null) return;
    const [px, py, pz] = point;
    const drop = dropGeometry.getAttribute("position");
    drop.setXYZ(0, px, py, pz);
    drop.setXYZ(1, px, py, guidePlaneZ);
    drop.needsUpdate = true;
    const arms = crossGeometry.getAttribute("position");
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
        if (!wasActive && hadPoint) eased.spike("pulse", 1);
      }
      hadPoint = true;
    },
    setState(hovered, isActive) {
      eased.setTarget("hover", hovered === "core" ? 1 : 0);
      eased.setTarget("verticalKnobHover", hovered === "vertical" ? 1 : 0);
      eased.setTarget("horizontalHover", hovered === "horizontal" ? 1 : 0);
      eased.setTarget("active", isActive && hovered === "core" ? 1 : 0);
      eased.setTarget("verticalKnobActive", isActive && hovered === "vertical" ? 1 : 0);
      eased.setTarget("horizontalActive", isActive && hovered === "horizontal" ? 1 : 0);
      if (isActive && !wasActive) eased.spike("pulse", 1); // grab pulse
      wasActive = isActive;
    },
    updateForPose(nextPose, ortho) {
      pose = nextPose;
      isOrthographic = ortho;
      applyCoreScale();
      eased.setTarget("verticalGate", verticalDragAllowed(pose) ? 1 : 0);
      const axis = horizontalDragAllowed(pose) ? null : horizontalDragAxis(pose);
      eased.setTarget("horizontalGate", axis !== null ? 1 : 0);
      if (axis !== null && axis !== hAxis) {
        const pos = horizontal.stemGeometry.getAttribute("position");
        if (axis === "x") {
          pos.setXYZ(1, HANDLE_OFFSET, 0, 0);
          horizontal.knob.position.set(HANDLE_OFFSET, 0, 0);
        } else {
          pos.setXYZ(1, 0, HANDLE_OFFSET, 0);
          horizontal.knob.position.set(0, HANDLE_OFFSET, 0);
        }
        pos.needsUpdate = true;
        hAxis = axis;
      }
    },
    tick(dt) {
      const dtc = Math.min(dt, DT_CLAMP);
      const isMoving = eased.advance(dtc);

      const hover = eased.get("hover");
      const expand = eased.get("pulse") + ACTIVE_HOLD_FRACTION * eased.get("active");
      const ringScale = RING_BASE * (1 + HOVER_SCALE * hover + PULSE_SCALE * expand);
      ring.scale.set(ringScale, ringScale, 1);
      const brighten = Math.min(1, HOVER_BRIGHTEN * hover + 0.5 * PULSE_SCALE * expand);
      coreMaterial.color.copy(coreBaseColor).lerp(white, brighten);

      applyHandle({
        lit: Math.max(eased.get("verticalKnobHover"), eased.get("verticalKnobActive")),
        gate: eased.get("verticalGate"),
        idleOpacity: HANDLE_IDLE_OPACITY,
        knob: vertical.knob,
        knobMaterial: vertical.knobMaterial,
        stem: vertical.stem,
        stemMaterial: vertical.stemMaterial,
      });
      applyHandle({
        lit: Math.max(eased.get("horizontalHover"), eased.get("horizontalActive")),
        gate: eased.get("horizontalGate"),
        idleOpacity: HORIZONTAL_HANDLE_IDLE_OPACITY,
        knob: horizontal.knob,
        knobMaterial: horizontal.knobMaterial,
        stem: horizontal.stem,
        stemMaterial: horizontal.stemMaterial,
      });

      return isMoving;
    },
    dispose: bag.dispose,
  };
}
