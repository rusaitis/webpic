import { beforeEach, describe, expect, it, vi } from "vitest";
import { vectorTriple } from "../../tests/fixtures.ts";
import { flushAsync } from "../../tests/helpers.ts";

// Capture every signal the store hands to computeField, and hold each compute open (never resolve)
// so two recomputes overlap — that's the window in which a superseded compute must be aborted.
// hoisted: vi.mock's factory runs before module-init, so the sink can't be a plain top-level const.
const { signals, resolvers } = vi.hoisted(() => ({
  signals: [] as (AbortSignal | undefined)[],
  // One resolver per compute, so a test can land them out of order and watch what the store keeps.
  resolvers: [] as Array<(field: unknown) => void>,
}));

vi.mock("@compute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@compute")>();
  return {
    ...actual, // keep computableFields real (setDataset needs it)
    computeField: vi.fn((_name: string, _dataset, signal?: AbortSignal) => {
      signals.push(signal);
      return new Promise((resolve) => {
        resolvers.push(resolve as (typeof resolvers)[number]);
      });
    }),
  };
});

// Imported after the mock is registered (vi.mock hoists above imports), so it binds the spy.
import { selectComputed } from "./selectors.ts";
import { createSimulationStore } from "./simulationStore.ts";

const bDataset = () => vectorTriple("B", { array: Float32Array });

beforeEach(() => {
  signals.length = 0;
  resolvers.length = 0;
});

// Only the fields the commit path reads; the mock's return never reaches a real consumer.
const field = (value: number) => ({
  data: new Float32Array([value, value]),
  shape: [2, 1, 1],
  meta: { longName: "", latex: "", siUnit: "", quantityType: "scalar" },
  units: "",
  latex: "",
  reduction: null,
});

describe("simulationStore compute cancellation", () => {
  it("aborts the superseded compute's signal when a newer recompute starts", () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset()); // recompute #1 — compute in flight
    store.getState().selectField("|E|"); // recompute #2 supersedes #1 (different field)

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true); // #1 cancelled the instant #2 started
    expect(signals[1]?.aborted).toBe(false); // #2 is the live compute
  });

  // The other half of the contract, and the half where the store actually regresses: aborting the
  // signal only helps if the compute honors it. A backend that ignores the signal and resolves late
  // must still not overwrite the newer result.
  it("discards a superseded compute that resolves after the newer one", async () => {
    const store = createSimulationStore();
    store.getState().setDataset(bDataset());
    store.getState().selectField("|E|");
    expect(resolvers).toHaveLength(2);

    resolvers[1]?.(field(2)); // the live compute lands first
    await flushAsync();
    resolvers[0]?.(field(1)); // the superseded one lands late, ignoring its abort
    await flushAsync();

    expect(store.getState().activeField).toBe("|E|");
    expect(selectComputed(store.getState())?.data[0]).toBe(2); // not clobbered by the stale 1
  });
});
