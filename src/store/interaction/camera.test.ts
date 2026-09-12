import { describe, expect, it } from "vitest";
import {
  addOrbitMomentum,
  addPanMomentum,
  applyPoseDelta,
  axisViewPose,
  CAMERA_FOV_DEG,
  type CameraMomentum,
  type CameraPose,
  cameraPosition,
  DEFAULT_POSE,
  DISTANCE_MAX,
  DISTANCE_MIN,
  dollyDeltaForScale,
  dollyPose,
  dollyPoseToCursor,
  ELEVATION_LIMIT,
  easeInOutCubic,
  formatPoseParam,
  isMomentumSettled,
  type KeyNudge,
  MOMENTUM_ZERO,
  normalizeWheelDelta,
  nudgePose,
  orbitPose,
  panPose,
  parsePoseParam,
  poseDelta,
  poseForBounds,
  rollPose,
  stepMomentum,
  UNIT_BOX_RADIUS,
  viewForward,
  viewPlaneOffset,
} from "./camera.ts";

// Drag deltas are viewport-height fractions (px / viewport height) — OrbitControls' unit, so the
// parity pins below are exact: a full-height drag is a full revolution, pan tracks the cursor.
const LEVEL: CameraPose = { target: [1, 2, 3], azimuth: 0, elevation: 0, distance: 4, roll: 0 };
const TAN_HALF_FOV = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);

describe("orbitPose", () => {
  it("spins azimuth opposite the horizontal drag and tilts elevation off the vertical", () => {
    const next = orbitPose(DEFAULT_POSE, 0.15, -0.08);
    expect(next.azimuth).toBeLessThan(DEFAULT_POSE.azimuth); // drag right ⇒ azimuth decreases
    expect(next.elevation).toBeLessThan(DEFAULT_POSE.elevation); // drag up ⇒ elevation drops (OrbitControls)
    expect(next.distance).toBe(DEFAULT_POSE.distance);
    expect(next.target).toBe(DEFAULT_POSE.target); // target untouched by orbit
  });

  it("matches OrbitControls' rate: a quarter-viewport drag turns a quarter revolution", () => {
    expect(orbitPose(LEVEL, 0.25, 0).azimuth).toBeCloseTo(-Math.PI / 2, 12);
  });

  it("clamps elevation to ±ELEVATION_LIMIT at the poles", () => {
    expect(orbitPose(LEVEL, 0, 10).elevation).toBeCloseTo(ELEVATION_LIMIT, 12); // drag down ⇒ rises
    expect(orbitPose(LEVEL, 0, -10).elevation).toBeCloseTo(-ELEVATION_LIMIT, 12); // drag up ⇒ falls
  });

  it("wraps azimuth into (-π, π] so it never runs away over a long drag", () => {
    const spun = orbitPose(LEVEL, -123.4, 0); // ~123 full revolutions leftward
    expect(spun.azimuth).toBeGreaterThan(-Math.PI);
    expect(spun.azimuth).toBeLessThanOrEqual(Math.PI);
  });

  it("returns a fresh object even for a zero delta", () => {
    const next = orbitPose(DEFAULT_POSE, 0, 0);
    expect(next).not.toBe(DEFAULT_POSE);
    expect(next.azimuth).toBeCloseTo(DEFAULT_POSE.azimuth, 12);
    expect(next.elevation).toBeCloseTo(DEFAULT_POSE.elevation, 12);
  });
});

describe("dollyPose", () => {
  it("is geometric: zoom in (deltaY < 0) shrinks distance, out grows it", () => {
    expect(dollyPose(LEVEL, -100).distance).toBeLessThan(LEVEL.distance);
    expect(dollyPose(LEVEL, 100).distance).toBeGreaterThan(LEVEL.distance);
  });

  it("matches OrbitControls' rate: 100 wheel units scale distance by exactly 1/0.95", () => {
    expect(dollyPose(LEVEL, 100).distance / LEVEL.distance).toBeCloseTo(1 / 0.95, 12);
    expect(dollyPose(LEVEL, -100).distance / LEVEL.distance).toBeCloseTo(0.95, 12);
  });

  it("clamps distance to [DISTANCE_MIN, DISTANCE_MAX]", () => {
    expect(dollyPose(LEVEL, -1e6).distance).toBeCloseTo(DISTANCE_MIN, 12);
    expect(dollyPose(LEVEL, 1e6).distance).toBeCloseTo(DISTANCE_MAX, 12);
  });

  it("leaves angles and target untouched", () => {
    const next = dollyPose(LEVEL, 50);
    expect(next.azimuth).toBe(LEVEL.azimuth);
    expect(next.elevation).toBe(LEVEL.elevation);
    expect(next.target).toBe(LEVEL.target);
  });

  it("flies through the near limit: zoom-in past DISTANCE_MIN pins distance and walks the pivot", () => {
    const deltaY = -300;
    // The geometric scale this delta applies, measured where nothing clamps (distance 10).
    const scale = dollyPose({ ...LEVEL, distance: 10 }, deltaY).distance / 10;
    const pinned: CameraPose = { ...LEVEL, distance: DISTANCE_MIN }; // viewForward = (-1, 0, 0)
    const next = dollyPose(pinned, deltaY);
    const step = DISTANCE_MIN - DISTANCE_MIN * scale; // the zoom-in distance couldn't absorb
    expect(next.distance).toBe(DISTANCE_MIN);
    expect(next.target[0]).toBeCloseTo((pinned.target[0] ?? Number.NaN) - step, 12); // forward = −x
    expect(next.target[1]).toBeCloseTo(pinned.target[1] ?? Number.NaN, 12);
    expect(next.target[2]).toBeCloseTo(pinned.target[2] ?? Number.NaN, 12);
  });

  it("zoom-out at the near limit grows distance instead of walking", () => {
    const next = dollyPose({ ...LEVEL, distance: DISTANCE_MIN }, 200);
    expect(next.distance).toBeGreaterThan(DISTANCE_MIN);
    expect(next.target).toBe(LEVEL.target); // no fly-through on the way out
  });
});

describe("rollPose", () => {
  it("banks by the delta and touches nothing else", () => {
    const next = rollPose(LEVEL, 0.3);
    expect(next.roll).toBeCloseTo(0.3, 12);
    expect(next.azimuth).toBe(LEVEL.azimuth);
    expect(next.elevation).toBe(LEVEL.elevation);
    expect(next.distance).toBe(LEVEL.distance);
    expect(next.target).toBe(LEVEL.target);
  });

  it("wraps the result into (−π, π] — also absorbing an atan2 branch jump", () => {
    expect(rollPose({ ...LEVEL, roll: 3.0 }, 0.4).roll).toBeCloseTo(3.0 + 0.4 - 2 * Math.PI, 12);
    // A spurious +2π delta (atan2 crossing ±π) wraps back to no net bank.
    expect(rollPose(LEVEL, 2 * Math.PI).roll).toBeCloseTo(0, 12);
  });

  it("returns a fresh object so subscribeWithSelector fires on a zero delta", () => {
    const next = rollPose(LEVEL, 0);
    expect(next).not.toBe(LEVEL);
    expect(next.roll).toBeCloseTo(LEVEL.roll, 12);
  });
});

describe("normalizeWheelDelta", () => {
  it("passes pixel-mode deltas through unchanged", () => {
    expect(normalizeWheelDelta(-120, 0, false)).toBe(-120);
  });

  it("scales line mode ×16 and page mode ×100 (OrbitControls parity)", () => {
    expect(normalizeWheelDelta(3, 1, false)).toBe(48);
    expect(normalizeWheelDelta(-3, 1, false)).toBe(-48);
    expect(normalizeWheelDelta(1, 2, false)).toBe(100);
  });

  it("boosts ctrl-wheel trackpad pinches ×10", () => {
    expect(normalizeWheelDelta(-12, 0, true)).toBe(-120);
  });

  it("composes the pinch gain with the mode multiplier", () => {
    expect(normalizeWheelDelta(1, 1, true)).toBe(160);
  });
});

describe("viewPlaneOffset", () => {
  const TILTED: CameraPose = {
    target: [0, 0, 0],
    azimuth: 0.7,
    elevation: 0.4,
    distance: 2,
    roll: 0,
  };

  it("spans an orthonormal screen basis: unit axes, ⟂ each other and the view forward", () => {
    const right = viewPlaneOffset(TILTED, 1, 0);
    const up = viewPlaneOffset(TILTED, 0, 1);
    const ce = Math.cos(TILTED.elevation);
    const se = Math.sin(TILTED.elevation);
    const forward: readonly [number, number, number] = [
      -ce * Math.cos(TILTED.azimuth),
      -ce * Math.sin(TILTED.azimuth),
      -se,
    ];
    expect(Math.hypot(...right)).toBeCloseTo(1, 12);
    expect(Math.hypot(...up)).toBeCloseTo(1, 12);
    expect(right[0] * up[0] + right[1] * up[1] + right[2] * up[2]).toBeCloseTo(0, 12);
    for (const axis of [right, up]) {
      expect(axis[0] * forward[0] + axis[1] * forward[1] + axis[2] * forward[2]).toBeCloseTo(0, 12);
    }
  });

  it("reduces to world +z for the up axis when the camera is level", () => {
    const up = viewPlaneOffset(LEVEL, 0, 1);
    expect(up[0]).toBeCloseTo(0, 12);
    expect(up[1]).toBeCloseTo(0, 12);
    expect(up[2]).toBeCloseTo(1, 12);
  });
});

describe("panPose", () => {
  it("moves only the target, scaled by distance", () => {
    // At azimuth 0 a horizontal drag slides the target along world-y (screenRight = (0,1,0)).
    const near = panPose({ ...LEVEL, distance: 1 }, 0.1, 0);
    const far = panPose({ ...LEVEL, distance: 4 }, 0.1, 0);
    const dNear = near.target[1] - LEVEL.target[1];
    const dFar = far.target[1] - LEVEL.target[1];
    expect(far.azimuth).toBe(LEVEL.azimuth);
    expect(far.elevation).toBe(LEVEL.elevation);
    expect(far.distance).toBe(LEVEL.distance);
    expect(Math.abs(dFar)).toBeCloseTo(4 * Math.abs(dNear), 12); // distance-proportional
  });

  it("tracks the cursor exactly: a drag moves the target by 2·tan(fov/2)·distance per viewport", () => {
    const next = panPose(LEVEL, 0, 0.5); // half-viewport drag down at level ⇒ target rises +z
    expect(next.target[2] - LEVEL.target[2]).toBeCloseTo(
      0.5 * 2 * TAN_HALF_FOV * LEVEL.distance,
      12,
    );
  });

  it("at level elevation a vertical drag moves target along world-z only", () => {
    const next = panPose(LEVEL, 0, 0.08); // azimuth 0, elevation 0 ⇒ screenUp = +z
    expect(next.target[0]).toBeCloseTo(LEVEL.target[0], 12);
    expect(next.target[1]).toBeCloseTo(LEVEL.target[1], 12);
    expect(next.target[2]).toBeGreaterThan(LEVEL.target[2]); // drag down ⇒ target rises (+z)
  });

  it("keeps full authority at the elevation clamp — the pole degenerates orbit, not pan", () => {
    // Looking straight down, screenUp loses its z-component but both basis vectors stay unit-length
    // in the xy-plane, so a drag there displaces the target by exactly as much as one at level.
    const pole: CameraPose = { ...LEVEL, elevation: ELEVATION_LIMIT };
    const next = panPose(pole, 0.1, 0.05);
    const moved = Math.hypot(
      next.target[0] - pole.target[0],
      next.target[1] - pole.target[1],
      next.target[2] - pole.target[2],
    );
    expect(moved).toBeCloseTo(Math.hypot(0.1, 0.05) * 2 * TAN_HALF_FOV * pole.distance, 12);
  });

  it("at level elevation a horizontal drag stays in the xy-plane, world tracking the cursor", () => {
    const next = panPose(LEVEL, 0.1, 0); // drag right; azimuth 0 ⇒ screenRight = (0,1,0)
    expect(next.target[2]).toBeCloseTo(LEVEL.target[2], 12); // z held (horizontal plane)
    expect(next.target[0]).toBeCloseTo(LEVEL.target[0], 12); // azimuth 0 ⇒ no x component
    // Grab-drag: drag right pushes the world right, so the target slides left along −screenRight (−y).
    expect(next.target[1]).toBeLessThan(LEVEL.target[1]);
  });
});

const FRAME_MS = 1000 / 60;

function glideToRest(
  start: CameraPose,
  initial: CameraMomentum,
): { pose: CameraPose; frames: number } {
  let pose = start;
  let momentum = initial;
  let frames = 0;
  while (!isMomentumSettled(momentum) && frames < 1000) {
    const stepped = stepMomentum(pose, momentum, FRAME_MS);
    pose = stepped.pose;
    momentum = stepped.momentum;
    frames++;
  }
  expect(isMomentumSettled(momentum)).toBe(true);
  return { pose, frames };
}

// What a glide is allowed to leave on the table: the 1.5e-4 settle epsilon × ORBIT_SENS (2π) ≈
// 9.4e-4 rad, i.e. sub-pixel at any sane viewport.
const SETTLE_RESIDUE = 1e-3;

describe("stepMomentum", () => {
  it("conserves the drag: a glide lands where the undamped orbit would (sub-pixel residue)", () => {
    const direct = orbitPose(DEFAULT_POSE, 0.2, -0.1);
    const { pose, frames } = glideToRest(DEFAULT_POSE, addOrbitMomentum(MOMENTUM_ZERO, 0.2, -0.1));
    expect(frames).toBeGreaterThan(20); // it glides, it doesn't snap
    expect(Math.abs(pose.azimuth - direct.azimuth)).toBeLessThan(SETTLE_RESIDUE);
    expect(Math.abs(pose.elevation - direct.elevation)).toBeLessThan(SETTLE_RESIDUE);
    expect(pose.target).toBe(DEFAULT_POSE.target); // orbit momentum never moves the target
  });

  it("releases the tuned damping fraction per 60 fps frame, geometrically", () => {
    // 0.10/frame: OrbitControls f=0.035 × ~3 update calls/frame ≈ 0.10 at 60 fps.
    const m0 = addOrbitMomentum(MOMENTUM_ZERO, 0.5, 0);
    const s1 = stepMomentum(LEVEL, m0, FRAME_MS);
    const s2 = stepMomentum(s1.pose, s1.momentum, FRAME_MS);
    expect(s1.momentum.orbitDx / m0.orbitDx).toBeCloseTo(1 - 0.1, 12);
    expect(s2.momentum.orbitDx / s1.momentum.orbitDx).toBeCloseTo(1 - 0.1, 12);
  });

  it("respects the elevation clamp mid-glide", () => {
    const { pose } = glideToRest(LEVEL, addOrbitMomentum(MOMENTUM_ZERO, 0, 100));
    expect(pose.elevation).toBeCloseTo(ELEVATION_LIMIT, 9);
  });

  it("pan momentum glides only the target", () => {
    const direct = panPose(LEVEL, 0.12, -0.07);
    const { pose } = glideToRest(LEVEL, addPanMomentum(MOMENTUM_ZERO, 0.12, -0.07));
    expect(pose.azimuth).toBe(LEVEL.azimuth);
    expect(pose.elevation).toBe(LEVEL.elevation);
    expect(pose.distance).toBe(LEVEL.distance);
    // Residue bound: the 1.5e-4 settle epsilon × pan scale (2·tan(fov/2)·distance ≈ 3.3) ≈ 5e-4.
    for (let i = 0; i < 3; i++) {
      expect(
        Math.abs((pose.target[i] ?? Number.NaN) - (direct.target[i] ?? Number.NaN)),
      ).toBeLessThan(6e-4);
    }
  });

  it("a zero dt releases nothing", () => {
    const m0 = addOrbitMomentum(addPanMomentum(MOMENTUM_ZERO, 0.05, 0.06), 0.3, -0.2);
    const { pose, momentum } = stepMomentum(DEFAULT_POSE, m0, 0);
    expect(momentum).toEqual(m0);
    expect(pose.azimuth).toBeCloseTo(DEFAULT_POSE.azimuth, 12);
    expect(pose.elevation).toBeCloseTo(DEFAULT_POSE.elevation, 12);
  });
});

describe("dollyPoseToCursor", () => {
  const POSE: CameraPose = {
    target: [1, 2, 3],
    azimuth: 0.9,
    elevation: 0.5,
    distance: 3,
    roll: 0,
  };

  // World point → ndc under the z-up orbit camera (the inverse of the cursor-ray construction).
  function projectToNdc(
    pose: CameraPose,
    point: readonly [number, number, number],
    aspect: number,
  ): readonly [number, number] {
    const ce = Math.cos(pose.elevation);
    const se = Math.sin(pose.elevation);
    const sa = Math.sin(pose.azimuth);
    const ca = Math.cos(pose.azimuth);
    const f = [-ce * ca, -ce * sa, -se] as const; // unit forward, camera → target
    const r = [-sa, ca, 0] as const;
    const u = [-se * ca, -se * sa, ce] as const;
    const [tx, ty, tz] = pose.target;
    const v = [
      point[0] - (tx - f[0] * pose.distance),
      point[1] - (ty - f[1] * pose.distance),
      point[2] - (tz - f[2] * pose.distance),
    ] as const;
    const depth = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
    return [
      (v[0] * r[0] + v[1] * r[1] + v[2] * r[2]) / (depth * TAN_HALF_FOV * aspect),
      (v[0] * u[0] + v[1] * u[1] + v[2] * u[2]) / (depth * TAN_HALF_FOV),
    ];
  }

  it("a centered cursor is exactly the plain dolly", () => {
    expect(dollyPoseToCursor(LEVEL, -120, 0, 0, 1.5)).toEqual(dollyPose(LEVEL, -120));
  });

  it("keeps the world point under the cursor at the same screen position through the zoom", () => {
    const ndcX = 0.55;
    const ndcY = -0.35;
    const aspect = 1.78;
    const ce = Math.cos(POSE.elevation);
    const se = Math.sin(POSE.elevation);
    const sa = Math.sin(POSE.azimuth);
    const ca = Math.cos(POSE.azimuth);
    const reach = POSE.distance * TAN_HALF_FOV;
    const kr = reach * ndcX * aspect;
    const ku = reach * ndcY;
    // The anchor: cursor ray ∩ target plane, written in the screenRight/screenUp basis.
    const anchor: readonly [number, number, number] = [
      (POSE.target[0] ?? 0) - kr * sa - ku * ca * se,
      (POSE.target[1] ?? 0) + kr * ca - ku * sa * se,
      (POSE.target[2] ?? 0) + ku * ce,
    ];
    const before = projectToNdc(POSE, anchor, aspect);
    expect(before[0]).toBeCloseTo(ndcX, 12); // the ray construction round-trips
    expect(before[1]).toBeCloseTo(ndcY, 12);

    for (const wheel of [-240, 180]) {
      const zoomed = dollyPoseToCursor(POSE, wheel, ndcX, ndcY, aspect);
      const after = projectToNdc(zoomed, anchor, aspect);
      expect(after[0]).toBeCloseTo(ndcX, 12);
      expect(after[1]).toBeCloseTo(ndcY, 12);
      expect(zoomed.azimuth).toBe(POSE.azimuth);
      expect(zoomed.elevation).toBe(POSE.elevation);
    }
  });

  it("zoom-in pulls the target toward the cursor side", () => {
    // LEVEL: azimuth 0, elevation 0 ⇒ screenRight = (0,1,0), screenUp = (0,0,1).
    const right = dollyPoseToCursor(LEVEL, -120, 0.8, 0, 1.5);
    expect(right.target[1]).toBeGreaterThan(LEVEL.target[1]);
    const up = dollyPoseToCursor(LEVEL, -120, 0, 0.8, 1.5);
    expect(up.target[2]).toBeGreaterThan(LEVEL.target[2]);
  });

  it("flies through the near limit: a pinned zoom-in walks the pivot forward, doesn't stall", () => {
    // LEVEL is level along +x ⇒ viewForward = (-1, 0, 0): the pivot advances in −x and nowhere else.
    const pinned: CameraPose = { ...LEVEL, distance: DISTANCE_MIN };
    const next = dollyPoseToCursor(pinned, -500, 0.8, 0.8, 1.7);
    expect(next.distance).toBeCloseTo(DISTANCE_MIN, 12); // distance stays pinned at the wall
    expect(next.target[0]).toBeLessThan(pinned.target[0] ?? Number.NaN); // marched forward
    expect(next.target[1]).toBeCloseTo(pinned.target[1] ?? Number.NaN, 12);
    expect(next.target[2]).toBeCloseTo(pinned.target[2] ?? Number.NaN, 12);
  });
});

describe("dollyDeltaForScale", () => {
  it("round-trips through dollyPose: the returned delta scales distance by exactly `scale`", () => {
    for (const scale of [0.5, 0.9, 1.25, 2]) {
      expect(dollyPose(LEVEL, dollyDeltaForScale(scale)).distance).toBeCloseTo(
        LEVEL.distance * scale,
        12,
      );
    }
  });

  it("feeds the cursor-anchored path so a pinch reuses the wheel's anchor math", () => {
    const viaScale = dollyPoseToCursor(LEVEL, dollyDeltaForScale(0.5), 0.4, -0.2, 1.5);
    expect(viaScale.distance).toBeCloseTo(LEVEL.distance * 0.5, 12);
    expect(viaScale.target).not.toBe(LEVEL.target); // off-center anchor moved the target
  });
});

describe("easeInOutCubic", () => {
  it("hits the endpoints and midpoint exactly, accelerating out of 0", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
    expect(easeInOutCubic(0.25)).toBeCloseTo(0.0625, 12); // 4t³ — slow start
    expect(easeInOutCubic(0.75)).toBeCloseTo(0.9375, 12); // symmetric slow finish
  });
});

describe("poseDelta / applyPoseDelta", () => {
  const A: CameraPose = { target: [0, 0, 0], azimuth: 0.4, elevation: 0.2, distance: 1, roll: 0 };
  const B: CameraPose = { target: [2, -4, 6], azimuth: -1.1, elevation: 0.9, distance: 4, roll: 0 };

  it("reproduces the endpoint at fraction 1 on an unperturbed base", () => {
    const end = applyPoseDelta(A, poseDelta(A, B), 1);
    expect(end.azimuth).toBeCloseTo(B.azimuth, 12);
    expect(end.elevation).toBeCloseTo(B.elevation, 12);
    expect(end.distance).toBeCloseTo(B.distance, 12);
    for (let i = 0; i < 3; i++) expect(end.target[i]).toBeCloseTo(B.target[i] ?? Number.NaN, 12);
  });

  it("composes: successive fractions summing to 1 land where one full step does", () => {
    const delta = poseDelta(A, B);
    let pose = A;
    for (const f of [0.1, 0.25, 0.4, 0.25]) pose = applyPoseDelta(pose, delta, f);
    const oneStep = applyPoseDelta(A, delta, 1);
    expect(pose.azimuth).toBeCloseTo(oneStep.azimuth, 12);
    expect(pose.elevation).toBeCloseTo(oneStep.elevation, 12);
    expect(pose.distance).toBeCloseTo(oneStep.distance, 12);
    for (let i = 0; i < 3; i++) {
      expect(pose.target[i]).toBeCloseTo(oneStep.target[i] ?? Number.NaN, 12);
    }
  });

  it("takes the shortest azimuth arc across the ±π seam", () => {
    const a: CameraPose = { ...A, azimuth: 2.9 };
    const b: CameraPose = { ...A, azimuth: -2.9 };
    const delta = poseDelta(a, b);
    // Shortest arc is +0.483 rad through π, not −5.8 rad back through 0.
    expect(delta.azimuth).toBeCloseTo(2 * Math.PI - 5.8, 12);
    const mid = applyPoseDelta(a, delta, 0.5);
    expect(Math.abs(mid.azimuth)).toBeCloseTo(Math.PI, 6); // the seam itself
  });

  it("steps distance geometrically (uniform zoom feel)", () => {
    expect(applyPoseDelta(A, poseDelta(A, B), 0.5).distance).toBeCloseTo(2, 12); // geometric mean
  });

  it("blends on a perturbed base: the result is base ⊕ fraction·delta, not from ⊕", () => {
    const delta = poseDelta(A, B);
    const perturbed: CameraPose = {
      target: [1, 1, 1],
      azimuth: 0.9,
      elevation: 0.1,
      distance: 2,
      roll: 0,
    };
    const next = applyPoseDelta(perturbed, delta, 0.5);
    expect(next.azimuth).toBeCloseTo(0.9 + 0.5 * delta.azimuth, 12);
    expect(next.elevation).toBeCloseTo(0.1 + 0.5 * delta.elevation, 12);
    expect(next.distance).toBeCloseTo(2 * Math.exp(0.5 * delta.logDistance), 12);
    expect(next.target[0]).toBeCloseTo(1 + 0.5 * (delta.target[0] ?? Number.NaN), 12);
  });

  it("clamps elevation and distance only when blended input pushed past a limit", () => {
    const delta = poseDelta(A, B); // elevation +0.7, distance ×4
    const nearPole: CameraPose = { ...A, elevation: ELEVATION_LIMIT - 0.1 };
    expect(applyPoseDelta(nearPole, delta, 1).elevation).toBe(ELEVATION_LIMIT);
    const nearMax: CameraPose = { ...A, distance: DISTANCE_MAX / 2 };
    expect(applyPoseDelta(nearMax, delta, 1).distance).toBe(DISTANCE_MAX);
  });
});

describe("nudgePose", () => {
  const still: KeyNudge = { azimuth: 0, elevation: 0, dolly: 0, roll: 0 };

  it("orbits at 1.2 rad over a held second", () => {
    const next = nudgePose(LEVEL, { ...still, azimuth: 1 }, 1000);
    expect(next.azimuth).toBeCloseTo(LEVEL.azimuth + 1.2, 12);
  });

  it("is dt-linear: two half-steps equal one full step", () => {
    const one = nudgePose(LEVEL, { ...still, elevation: 1 }, 500);
    const two = nudgePose(one, { ...still, elevation: 1 }, 500);
    expect(two.elevation).toBeCloseTo(
      nudgePose(LEVEL, { ...still, elevation: 1 }, 1000).elevation,
      12,
    );
  });

  it("dollies geometrically and never crosses the clamps", () => {
    const zoomIn = nudgePose(LEVEL, { ...still, dolly: 1 }, 1000);
    expect(zoomIn.distance).toBeCloseTo(LEVEL.distance * Math.exp(-1.5), 12);
    expect(nudgePose(LEVEL, { ...still, dolly: 1 }, 1e7).distance).toBe(DISTANCE_MIN);
    expect(nudgePose(LEVEL, { ...still, dolly: -1 }, 1e7).distance).toBe(DISTANCE_MAX);
  });

  it("clamps elevation off the poles and leaves the target alone", () => {
    const up = nudgePose(LEVEL, { ...still, elevation: 1 }, 1e7);
    expect(up.elevation).toBe(ELEVATION_LIMIT);
    expect(up.target).toBe(LEVEL.target);
  });

  it("flies through the near limit when held: a long zoom-in walks the pivot, doesn't stall", () => {
    const pinned: CameraPose = { ...LEVEL, distance: DISTANCE_MIN }; // viewForward = (-1, 0, 0)
    const next = nudgePose(pinned, { ...still, dolly: 1 }, 1000);
    expect(next.distance).toBe(DISTANCE_MIN);
    expect(next.target[0]).toBeLessThan(pinned.target[0] ?? Number.NaN); // marched forward in −x
  });

  it("banks at the keyboard roll rate (1.0 rad/s) without touching the orbit", () => {
    const banked = nudgePose(LEVEL, { ...still, roll: 1 }, 1000);
    expect(banked.roll).toBeCloseTo(LEVEL.roll + 1.0, 12);
    expect(banked.azimuth).toBe(LEVEL.azimuth);
    expect(banked.elevation).toBe(LEVEL.elevation);
    expect(banked.distance).toBe(LEVEL.distance);
  });
});

describe("cameraPosition", () => {
  it("places the eye at target − distance·viewForward", () => {
    const eye = cameraPosition(LEVEL); // azimuth/elevation 0 ⇒ viewForward = (-1, 0, 0)
    const forward = viewForward(LEVEL);
    expect(eye[0]).toBeCloseTo(LEVEL.target[0] - LEVEL.distance * forward[0], 12); // 1 − 4·(−1) = 5
    expect(eye[1]).toBeCloseTo(LEVEL.target[1] - LEVEL.distance * forward[1], 12);
    expect(eye[2]).toBeCloseTo(LEVEL.target[2] - LEVEL.distance * forward[2], 12);
  });
});

describe("nudgePose look mode", () => {
  const still: KeyNudge = { azimuth: 0, elevation: 0, dolly: 0, roll: 0 };
  const inside: CameraPose = { ...LEVEL, distance: 0.3 }; // a close-up pose; fly mode drives the flip

  it("pivots around the eye: a turn leaves the camera position fixed", () => {
    const eye0 = cameraPosition(inside);
    const eye1 = cameraPosition(nudgePose(inside, { ...still, azimuth: 1 }, 100, true));
    expect(eye1[0]).toBeCloseTo(eye0[0], 10);
    expect(eye1[1]).toBeCloseTo(eye0[1], 10);
    expect(eye1[2]).toBeCloseTo(eye0[2], 10);
  });

  it("flips A/D handedness vs orbit: azimuth +1 turns the opposite way (D = right)", () => {
    const orbit = nudgePose(inside, { ...still, azimuth: 1 }, 100, false);
    const look = nudgePose(inside, { ...still, azimuth: 1 }, 100, true);
    expect(orbit.azimuth - inside.azimuth).toBeCloseTo(-(look.azimuth - inside.azimuth), 12);
    expect(look.azimuth).toBeLessThan(inside.azimuth); // azimuth +1 now decreases azimuth
  });

  it("flips Q/E too: elevation +1 (E) looks up instead of raising the camera", () => {
    const look = nudgePose(inside, { ...still, elevation: 1 }, 100, true);
    expect(look.elevation).toBeLessThan(inside.elevation); // facing tilts up (−sin elevation rises)
  });

  it("leaves dolly and roll exactly as orbit mode — only the rotation pivot changes", () => {
    const look = nudgePose(inside, { ...still, dolly: 1, roll: 1 }, 100, true);
    const orbit = nudgePose(inside, { ...still, dolly: 1, roll: 1 }, 100, false);
    expect(look.distance).toBeCloseTo(orbit.distance, 12);
    expect(look.roll).toBeCloseTo(orbit.roll, 12);
  });
});

describe("roll", () => {
  it("poseDelta/applyPoseDelta take the shortest bank arc across ±π", () => {
    const a: CameraPose = { ...LEVEL, roll: 2.9 };
    const b: CameraPose = { ...LEVEL, roll: -2.9 };
    const delta = poseDelta(a, b);
    expect(delta.roll).toBeCloseTo(2 * Math.PI - 5.8, 12); // through ±π, not the long way back
    expect(Math.abs(applyPoseDelta(a, delta, 0.5).roll)).toBeCloseTo(Math.PI, 6);
  });

  it("axisViewPose and poseForBounds level the horizon", () => {
    const rolled: CameraPose = { ...DEFAULT_POSE, roll: 0.7 };
    expect(axisViewPose("+z", rolled).roll).toBe(0);
    expect(axisViewPose("-x", rolled).roll).toBe(0);
    expect(poseForBounds(rolled, { center: [0, 0, 0], radius: UNIT_BOX_RADIUS }, 1).roll).toBe(0);
  });

  it("round-trips through the pose param and defaults to 0 for pre-roll (6-field) links", () => {
    const pose: CameraPose = { ...DEFAULT_POSE, roll: -1.234 };
    expect(parsePoseParam(formatPoseParam(pose))?.roll).toBeCloseTo(-1.234, 4);
    expect(parsePoseParam("0.5,0.3,2,0,0,0")?.roll).toBe(0); // legacy link, no roll field
  });
});

describe("poseForBounds", () => {
  const sphere = { center: [0, 0, 0] as const, radius: UNIT_BOX_RADIUS };

  // Project a world point through the fitted pose's view + perspective and return |ndc| extrema.
  // Plain trig (no THREE): camera basis from azimuth/elevation, fov from CAMERA_FOV_DEG.
  function maxNdcOverSphere(pose: CameraPose, radius: number, aspect: number): number {
    const ce = Math.cos(pose.elevation);
    const se = Math.sin(pose.elevation);
    const sa = Math.sin(pose.azimuth);
    const ca = Math.cos(pose.azimuth);
    const [tx, ty, tz] = pose.target;
    const camX = tx + pose.distance * ce * ca;
    const camY = ty + pose.distance * ce * sa;
    const camZ = tz + pose.distance * se;
    const dot = (
      [ax, ay, az]: readonly [number, number, number],
      [bx, by, bz]: readonly [number, number, number],
    ): number => ax * bx + ay * by + az * bz;
    const fwd = [-ce * ca, -ce * sa, -se] as const;
    const right = [-sa, ca, 0] as const;
    const up = [-ca * se, -sa * se, ce] as const;
    const tanHalf = Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
    let worst = 0;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        for (let k = -2; k <= 2; k++) {
          const len = Math.hypot(i, j, k);
          if (len === 0) continue;
          const d = [
            tx + (radius * i) / len - camX,
            ty + (radius * j) / len - camY,
            tz + (radius * k) / len - camZ,
          ] as const;
          const z = dot(d, fwd);
          const ndcX = dot(d, right) / (z * tanHalf * aspect);
          const ndcY = dot(d, up) / (z * tanHalf);
          worst = Math.max(worst, Math.abs(ndcX), Math.abs(ndcY));
        }
      }
    }
    return worst;
  }

  it("frames every sphere point inside NDC in landscape and portrait", () => {
    for (const aspect of [0.5, 2.0]) {
      const fitted = poseForBounds(DEFAULT_POSE, sphere, aspect);
      expect(maxNdcOverSphere(fitted, sphere.radius, aspect)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the viewing direction and recenters on the sphere", () => {
    const start: CameraPose = {
      target: [1, 2, 3],
      azimuth: 1.1,
      elevation: -0.3,
      distance: 9,
      roll: 0,
    };
    const fitted = poseForBounds(start, { center: [4, 5, 6], radius: 2 }, 1.5);
    expect(fitted.azimuth).toBe(start.azimuth);
    expect(fitted.elevation).toBe(start.elevation);
    expect(fitted.target).toEqual([4, 5, 6]);
  });

  it("backs off further for a portrait viewport than a landscape one", () => {
    const landscape = poseForBounds(DEFAULT_POSE, sphere, 2.0);
    const portrait = poseForBounds(DEFAULT_POSE, sphere, 0.5);
    expect(portrait.distance).toBeGreaterThan(landscape.distance);
  });

  it("clamps degenerate radii to the dolly bounds", () => {
    expect(poseForBounds(DEFAULT_POSE, { center: [0, 0, 0], radius: 1e-9 }, 1).distance).toBe(
      DISTANCE_MIN,
    );
    expect(poseForBounds(DEFAULT_POSE, { center: [0, 0, 0], radius: 1e9 }, 1).distance).toBe(
      DISTANCE_MAX,
    );
  });
});

describe("pose param round-trip", () => {
  it("format → parse reproduces the pose to 1e-4 on every component", () => {
    const pose: CameraPose = {
      target: [0.1234, -2.5, 7.89],
      azimuth: -1.234,
      elevation: 0.6,
      distance: 3.21,
      roll: 0,
    };
    const back = parsePoseParam(formatPoseParam(pose));
    expect(back).not.toBeNull();
    expect(back?.azimuth).toBeCloseTo(pose.azimuth, 4);
    expect(back?.elevation).toBeCloseTo(pose.elevation, 4);
    expect(back?.distance).toBeCloseTo(pose.distance, 4);
    for (let i = 0; i < 3; i++) {
      expect(back?.target[i]).toBeCloseTo(pose.target[i] ?? Number.NaN, 4);
    }
  });

  it("normalizes through the pose invariants (wrap, clamps)", () => {
    const parsed = parsePoseParam("10,3,500,0,0,0"); // azimuth > π, elevation > limit, distance > max
    expect(parsed?.azimuth).toBeGreaterThan(-Math.PI);
    expect(parsed?.azimuth).toBeLessThanOrEqual(Math.PI);
    expect(parsed?.elevation).toBe(ELEVATION_LIMIT);
    expect(parsed?.distance).toBe(DISTANCE_MAX);
  });

  it("rejects malformed input with null", () => {
    for (const bad of [
      "",
      "1,2,3",
      "a,b,c,d,e,f",
      "1,2,Infinity,0,0,0",
      "1,2,-3,0,0,0",
      "1,2,0,0,0,0",
    ]) {
      expect(parsePoseParam(bad)).toBeNull();
    }
  });

  it("clamps huge crafted targets (a URL is a trust boundary — hypot overflow → NaN projection)", () => {
    const parsed = parsePoseParam("0,0,1,1.5e308,-1.5e308,1e30");
    expect(parsed?.target).toEqual([DISTANCE_MAX, -DISTANCE_MAX, DISTANCE_MAX]);
  });
});

describe("axisViewPose", () => {
  const POSE: CameraPose = {
    target: [1, 2, 3],
    azimuth: 0.7,
    elevation: 0.4,
    distance: 5,
    roll: 0,
  };

  it("aims down each lateral axis at level elevation, distance and target preserved", () => {
    expect(axisViewPose("+x", POSE)).toMatchObject({ azimuth: 0, elevation: 0 });
    expect(axisViewPose("-x", POSE)).toMatchObject({ azimuth: Math.PI, elevation: 0 });
    expect(axisViewPose("+y", POSE)).toMatchObject({ azimuth: Math.PI / 2, elevation: 0 });
    expect(axisViewPose("-y", POSE)).toMatchObject({ azimuth: -Math.PI / 2, elevation: 0 });
    for (const view of ["+x", "-x", "+y", "-y"] as const) {
      const next = axisViewPose(view, POSE);
      expect(next.distance).toBe(POSE.distance);
      expect(next.target).toBe(POSE.target);
    }
  });

  it("the ±z views tip to the clamped pole keeping the current azimuth (no surprise spin)", () => {
    const top = axisViewPose("+z", POSE);
    expect(top.elevation).toBe(ELEVATION_LIMIT);
    expect(top.azimuth).toBe(POSE.azimuth);
    const bottom = axisViewPose("-z", POSE);
    expect(bottom.elevation).toBe(-ELEVATION_LIMIT);
    expect(bottom.azimuth).toBe(POSE.azimuth);
  });
});
