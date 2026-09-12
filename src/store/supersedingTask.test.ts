import { describe, expect, it } from "vitest";
import { flushAsync } from "../../tests/helpers.ts";
import { createSupersedingTask, type TaskRun } from "./supersedingTask.ts";

// Both halves of the supersession contract, on the same overlap: the older run's signal aborts, AND
// its commit is discarded even when it is the one that resolves last (the failure mode a plain
// "latest wins" latch misses — a slow first compute landing after the fast second one).

describe("createSupersedingTask", () => {
  it("aborts the previous run's signal the instant a new call starts", () => {
    const runs: TaskRun[] = [];
    const task = createSupersedingTask(async (run: TaskRun) => {
      runs.push(run);
      await new Promise<never>(() => {}); // held open: both runs overlap
    });

    void task();
    void task();

    expect(runs).toHaveLength(2);
    expect(runs[0]?.signal.aborted).toBe(true);
    expect(runs[1]?.signal.aborted).toBe(false);
  });

  it("discards the superseded commit when the older body resolves last", async () => {
    const committed: string[] = [];
    const gates = new Map<string, () => void>();
    const task = createSupersedingTask(async (run: TaskRun, label: string) => {
      await new Promise<void>((resolve) => gates.set(label, resolve));
      if (!run.isCurrent()) return;
      committed.push(label);
    });

    void task("first");
    void task("second");
    gates.get("second")?.();
    await flushAsync();
    gates.get("first")?.(); // the superseded body finishes AFTER the winner
    await flushAsync();

    expect(committed).toEqual(["second"]);
  });

  it("keeps isCurrent true for a run nothing superseded", async () => {
    const seen: boolean[] = [];
    const task = createSupersedingTask(async (run: TaskRun) => {
      await flushAsync();
      seen.push(run.isCurrent());
    });

    await task();
    await task(); // sequential: each finishes before the next starts, so neither is superseded

    expect(seen).toEqual([true, true]);
  });
});
