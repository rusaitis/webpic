import { describe, expect, it } from "vitest";
import { REQUEST_IDS } from "./messages.ts";

describe("REQUEST_IDS", () => {
  it("assigns a unique id to every store→render-worker posting site", () => {
    // The whole point of the central map: a collision is unrepresentable. (Before centralizing, a
    // pickRay shared id 10 with setSceneOverlay across separate per-bridge constants.)
    const ids = Object.values(REQUEST_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
