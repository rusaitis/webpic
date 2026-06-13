import { describe, expect, it } from "vitest";
import { warmScene } from "./managedScene.ts";

const resolved = () => Promise.resolve();
const rejected = (message: string) => () => Promise.reject(new Error(message));

describe("warmScene", () => {
  it("commits a teardown (undefined next) without warming", async () => {
    let warmed = false;
    const ok = await warmScene(
      undefined,
      () => {
        warmed = true;
        return resolved();
      },
      () => true,
      () => {},
      () => {},
    );
    expect(ok).toBe(true);
    expect(warmed).toBe(false); // nothing to warm on a teardown
  });

  it("commits when not superseded", async () => {
    let disposed = false;
    const ok = await warmScene(
      {},
      resolved,
      () => true,
      () => {
        disposed = true;
      },
      () => {},
    );
    expect(ok).toBe(true);
    expect(disposed).toBe(false);
  });

  it("disposes and bails when superseded mid-warm", async () => {
    const next = { id: 1 };
    let disposed: unknown;
    const ok = await warmScene(
      next,
      resolved,
      () => false,
      (n) => {
        disposed = n;
      },
      () => {},
    );
    expect(ok).toBe(false);
    expect(disposed).toBe(next);
  });

  it("swallows a warm failure but still commits (the paint falls back to a sync compile)", async () => {
    let reported: unknown;
    const ok = await warmScene(
      {},
      rejected("warm boom"),
      () => true,
      () => {},
      (e) => {
        reported = e;
      },
    );
    expect(ok).toBe(true);
    expect((reported as Error).message).toBe("warm boom");
  });

  it("a supersede during a failed warm still discards the scene", async () => {
    let disposed = false;
    const ok = await warmScene(
      {},
      rejected("x"),
      () => false,
      () => {
        disposed = true;
      },
      () => {},
    );
    expect(ok).toBe(false);
    expect(disposed).toBe(true);
  });
});
