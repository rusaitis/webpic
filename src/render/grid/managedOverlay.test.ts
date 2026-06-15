import { describe, expect, it, vi } from "vitest";
import type { SceneOverlayConfig } from "../messages.ts";

// Mock the GPU scene factory — the manager's logic (warm-then-commit, epoch supersede, source
// retention + device-restore rebuild) is what we isolate; the real overlay scene needs a device and
// is exercised by overlayScene.test.ts + the worker.*.test.ts integration suites.
const { created } = vi.hoisted(() => ({ created: [] as FakeOverlay[] }));

interface FakeOverlay {
  readonly scene: object;
  disposed: boolean;
}

vi.mock("./overlayScene.ts", () => ({
  createSceneOverlay: (config: SceneOverlayConfig) => {
    const fake: FakeOverlay = { scene: { config }, disposed: false };
    created.push(fake);
    return {
      get scene() {
        return fake.scene;
      },
      dispose() {
        fake.disposed = true;
      },
    };
  },
}));

const { createManagedOverlay } = await import("./managedOverlay.ts");

function harness() {
  created.length = 0;
  let warm: Promise<void> = Promise.resolve();
  let renders = 0;
  const overlay = createManagedOverlay({
    requestRender: () => {
      renders += 1;
    },
    reportFault: () => {},
    warmComposite: () => warm,
  });
  return {
    overlay,
    created,
    renders: () => renders,
    setWarm: (p: Promise<void>) => {
      warm = p;
    },
  };
}

// The mocked factory ignores the config's shape; a bare tagged object stands in for a real config.
const config = (tag = "a"): SceneOverlayConfig => ({ tag }) as unknown as SceneOverlayConfig;

describe("createManagedOverlay", () => {
  it("builds, commits, and exposes the scene via current()", async () => {
    const { overlay, created, renders } = harness();
    expect(overlay.current()).toBeUndefined();
    await overlay.build(config());
    expect(created).toHaveLength(1);
    expect(overlay.current()?.scene).toBe(created[0]?.scene);
    expect(renders()).toBe(1); // a commit repaints
  });

  it("replaces the committed overlay, disposing the previous", async () => {
    const { overlay, created } = harness();
    await overlay.build(config("a"));
    await overlay.build(config("b"));
    expect(created).toHaveLength(2);
    expect(created[0]?.disposed).toBe(true);
    expect(created[1]?.disposed).toBe(false);
    expect(overlay.current()?.scene).toBe(created[1]?.scene);
  });

  it("tears down on null, disposing the previous", async () => {
    const { overlay, created } = harness();
    await overlay.build(config());
    await overlay.build(null);
    expect(overlay.current()).toBeUndefined();
    expect(created[0]?.disposed).toBe(true);
  });

  it("discards a scene superseded mid-warm (a device-restore epoch bump)", async () => {
    const { overlay, created, setWarm } = harness();
    let release = () => {};
    setWarm(new Promise<void>((resolve) => (release = resolve)));
    const pending = overlay.build(config());
    overlay.supersedeWarms(); // a device loss raced the build — supersede the in-flight warm
    release();
    await pending;
    expect(created[0]?.disposed).toBe(true); // discarded, not committed
    expect(overlay.current()).toBeUndefined();
  });

  it("rebuilds from the retained source on device-restore", async () => {
    const { overlay, created } = harness();
    await overlay.build(config("a"));
    overlay.disposeForRebuild();
    expect(created[0]?.disposed).toBe(true);
    overlay.rebuild();
    expect(created).toHaveLength(2); // fresh scene from the retained config
    expect(overlay.current()?.scene).toBe(created[1]?.scene);
  });

  it("rebuild after a teardown produces no scene", async () => {
    const { overlay, created } = harness();
    await overlay.build(config());
    await overlay.build(null); // source cleared
    overlay.disposeForRebuild();
    overlay.rebuild();
    expect(overlay.current()).toBeUndefined();
    expect(created).toHaveLength(1); // nothing new built
  });

  it("dispose tears down and clears current()", async () => {
    const { overlay, created } = harness();
    await overlay.build(config());
    overlay.dispose();
    expect(created[0]?.disposed).toBe(true);
    expect(overlay.current()).toBeUndefined();
  });
});
