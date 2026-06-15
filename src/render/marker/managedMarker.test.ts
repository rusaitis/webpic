import type { CameraPose } from "@schema/camera.ts";
import type { MarkerPart } from "@schema/marker.ts";
import { describe, expect, it, vi } from "vitest";
import type { MarkerConfig } from "../messages.ts";

// Mock the GPU scene factory — the manager's logic (seed-on-build, the easing dt clock, epoch
// supersede, retained-state device-restore rebuild) is what we isolate; the real marker scene needs a
// device. Each fake records its seeded pose + position/state and the dt of every tick.
const { created } = vi.hoisted(() => ({ created: [] as FakeMarker[] }));

interface FakeMarker {
  readonly scene: object;
  disposed: boolean;
  point: readonly [number, number, number] | null;
  hovered: MarkerPart;
  active: boolean;
  pose?: CameraPose;
  orthographic?: boolean;
  ticks: number[];
  tickResult: boolean;
}

vi.mock("./markerScene.ts", () => ({
  createMarkerScene: (config: MarkerConfig) => {
    const fake: FakeMarker = {
      scene: { config },
      disposed: false,
      point: null,
      hovered: "none",
      active: false,
      ticks: [],
      tickResult: false,
    };
    created.push(fake);
    return {
      get scene() {
        return fake.scene;
      },
      setPoint(point: readonly [number, number, number] | null) {
        fake.point = point;
      },
      setState(hovered: MarkerPart, active: boolean) {
        fake.hovered = hovered;
        fake.active = active;
      },
      updateForPose(pose: CameraPose, orthographic: boolean) {
        fake.pose = pose;
        fake.orthographic = orthographic;
      },
      tick(dt: number) {
        fake.ticks.push(dt);
        return fake.tickResult;
      },
      dispose() {
        fake.disposed = true;
      },
    };
  },
}));

const { createManagedMarker } = await import("./managedMarker.ts");

const POSE: CameraPose = { target: [0, 0, 0], azimuth: 0, elevation: 0, distance: 3 };

function harness() {
  created.length = 0;
  let warm: Promise<void> = Promise.resolve();
  let pose: CameraPose = POSE;
  let orthographic = false;
  const marker = createManagedMarker({
    pose: () => pose,
    isOrthographic: () => orthographic,
    requestRender: () => {},
    reportFault: () => {},
    warmComposite: () => warm,
  });
  return {
    marker,
    created,
    setWarm: (p: Promise<void>) => {
      warm = p;
    },
    setPose: (p: CameraPose) => {
      pose = p;
    },
    setOrtho: (o: boolean) => {
      orthographic = o;
    },
  };
}

// The mocked factory ignores the config's shape.
const config = (): MarkerConfig => ({}) as unknown as MarkerConfig;

describe("createManagedMarker", () => {
  it("builds + seeds the live pose on the fresh scene", async () => {
    const { marker, created } = harness();
    await marker.build(config());
    expect(created[0]?.pose).toBe(POSE);
    expect(created[0]?.point).toBeNull();
    expect(marker.current()?.scene).toBe(created[0]?.scene);
  });

  it("setPoint updates the live scene, copies the point, and retains state", async () => {
    const { marker, created } = harness();
    await marker.build(config());
    const src: [number, number, number] = [1, 2, 3];
    marker.setPoint(src, "core", true);
    expect(created[0]?.point).toEqual([1, 2, 3]);
    expect(created[0]?.point).not.toBe(src); // copied, not aliased to the message's array
    expect(created[0]?.hovered).toBe("core");
    expect(created[0]?.active).toBe(true);
  });

  it("retains position/state so a replacement scene re-seeds them", async () => {
    const { marker, created } = harness();
    await marker.build(config());
    marker.setPoint([1, 2, 3], "vertical", true);
    await marker.build(config()); // replace
    expect(created[1]?.point).toEqual([1, 2, 3]); // seeded from the retained state
    expect(created[1]?.hovered).toBe("vertical");
    expect(created[1]?.active).toBe(true);
    expect(created[0]?.disposed).toBe(true); // previous disposed
  });

  it("tick derives dt from the rAF timestamp and returns the scene's result", async () => {
    const { marker, created } = harness();
    await marker.build(config());
    const fake = created[0];
    if (fake === undefined) throw new Error("expected a built marker");
    fake.tickResult = true;
    expect(marker.tick(1000)).toBe(true); // first tick of a fresh scene assumes 1/60
    expect(marker.tick(1016)).toBe(true);
    expect(fake.ticks[0]).toBeCloseTo(1 / 60);
    expect(fake.ticks[1]).toBeCloseTo(0.016); // (1016 - 1000) / 1000
  });

  it("tick is a no-op (false) when no marker is built", () => {
    const { marker } = harness();
    expect(marker.tick(1000)).toBe(false);
  });

  it("applyPose re-applies the live pose + projection", async () => {
    const { marker, created, setPose, setOrtho } = harness();
    await marker.build(config());
    const moved: CameraPose = { target: [1, 1, 1], azimuth: 1, elevation: 0.5, distance: 5 };
    setPose(moved);
    setOrtho(true);
    marker.applyPose();
    expect(created[0]?.pose).toBe(moved);
    expect(created[0]?.orthographic).toBe(true);
  });

  it("discards a scene superseded mid-warm", async () => {
    const { marker, created, setWarm } = harness();
    let release = () => {};
    setWarm(new Promise<void>((resolve) => (release = resolve)));
    const pending = marker.build(config());
    marker.supersedeWarms();
    release();
    await pending;
    expect(created[0]?.disposed).toBe(true);
    expect(marker.current()).toBeUndefined();
  });

  it("rebuilds from the retained source + state on device-restore", async () => {
    const { marker, created } = harness();
    await marker.build(config());
    marker.setPoint([4, 5, 6], "horizontal", false);
    marker.disposeForRebuild();
    expect(created[0]?.disposed).toBe(true);
    marker.rebuild();
    expect(created[1]?.point).toEqual([4, 5, 6]); // re-seeded
    expect(created[1]?.hovered).toBe("horizontal");
    expect(marker.current()?.scene).toBe(created[1]?.scene);
  });

  it("dispose tears down and clears current()", async () => {
    const { marker, created } = harness();
    await marker.build(config());
    marker.dispose();
    expect(created[0]?.disposed).toBe(true);
    expect(marker.current()).toBeUndefined();
  });
});
