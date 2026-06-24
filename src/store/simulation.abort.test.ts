import { describe, expect, it, vi } from "vitest";
import { vectorTriple } from "../../tests/fixtures.ts";

// Capture every signal the store hands to computeField, and hold each compute open (never resolve)
// so two recomputes overlap — that's the window in which a superseded compute must be aborted.
// hoisted: vi.mock's factory runs before module-init, so the sink can't be a plain top-level const.
const { signals } = vi.hoisted(() => ({ signals: [] as (AbortSignal | undefined)[] }));

vi.mock("@compute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@compute")>();
  return {
    ...actual, // keep computableFields real (setDataset needs it)
    computeField: vi.fn((_name: string, _dataset, signal?: AbortSignal) => {
      signals.push(signal);
      return new Promise<never>(() => {}); // pending forever: the recompute stays in flight
    }),
  };
});

// Imported after the mock is registered (vi.mock hoists above imports), so it binds the spy.
import { createSimulationStore } from "./simulation.ts";

const bDataset = () => vectorTriple("B", { array: Float32Array });

describe("simulationStore compute cancellation", () => {
  it("aborts the superseded compute's signal when a newer recompute starts", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset()); // recompute #1 — compute in flight
    store.getState().selectField("|E|"); // recompute #2 supersedes #1 (different field)

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true); // #1 cancelled the instant #2 started
    expect(signals[1]?.aborted).toBe(false); // #2 is the live compute
  });
});
