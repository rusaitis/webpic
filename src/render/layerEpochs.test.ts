import { describe, expect, it, vi } from "vitest";
import { createLayerEpochs } from "./layerEpochs.ts";
import type { LayerEntry } from "./layerRegistry.ts";

// A LayerEntry is a scene + source; only `scene.dispose` is exercised here.
function fakeEntry(): LayerEntry & { disposed: () => number } {
  const dispose = vi.fn();
  const entry = { kind: "volume", scene: { dispose }, source: {} } as unknown as LayerEntry;
  return Object.assign(entry, { disposed: () => dispose.mock.calls.length });
}

describe("createLayerEpochs", () => {
  it("invalidates an in-flight warm when a newer build opens for the same id", () => {
    const epochs = createLayerEpochs();
    const first = epochs.begin("layer-0");
    expect(epochs.isCurrent("layer-0", first)).toBe(true);
    const second = epochs.begin("layer-0");
    expect(epochs.isCurrent("layer-0", first)).toBe(false);
    expect(epochs.isCurrent("layer-0", second)).toBe(true);
  });

  it("keeps each id's epoch independent", () => {
    const epochs = createLayerEpochs();
    const a = epochs.begin("layer-0");
    epochs.begin("layer-1");
    expect(epochs.isCurrent("layer-0", a)).toBe(true);
  });

  it("invalidates every listed id on supersedeAll", () => {
    const epochs = createLayerEpochs();
    const a = epochs.begin("layer-0");
    const b = epochs.begin("layer-1");
    epochs.supersedeAll(["layer-0", "layer-1"]);
    expect(epochs.isCurrent("layer-0", a)).toBe(false);
    expect(epochs.isCurrent("layer-1", b)).toBe(false);
  });

  it("exposes a warming entry until it is released, and only releases that entry", () => {
    const epochs = createLayerEpochs();
    const warming = fakeEntry();
    const other = fakeEntry();
    epochs.hold("layer-0", warming);
    expect(epochs.warming("layer-0")).toBe(warming);
    epochs.release("layer-0", other); // a superseded build must not clear the live one
    expect(epochs.warming("layer-0")).toBe(warming);
    epochs.release("layer-0", warming);
    expect(epochs.warming("layer-0")).toBeUndefined();
  });

  it("holds a replaced scene one swap before disposing it", () => {
    const epochs = createLayerEpochs();
    const first = fakeEntry();
    const second = fakeEntry();
    epochs.defer(first);
    expect(first.disposed()).toBe(0); // still reachable by an in-flight rAF frame
    epochs.defer(second);
    expect(first.disposed()).toBe(1);
    expect(second.disposed()).toBe(0);
  });

  it("disposes the held scene on disposeDeferred, and is idempotent", () => {
    const epochs = createLayerEpochs();
    const entry = fakeEntry();
    epochs.defer(entry);
    epochs.disposeDeferred();
    epochs.disposeDeferred();
    expect(entry.disposed()).toBe(1);
  });

  it("drops the held scene without disposing it on forgetDeferred", () => {
    // The device is gone and took its textures; calling dispose would throw on a dead device.
    const epochs = createLayerEpochs();
    const entry = fakeEntry();
    epochs.defer(entry);
    epochs.forgetDeferred();
    epochs.disposeDeferred();
    expect(entry.disposed()).toBe(0);
  });
});
