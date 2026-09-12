// The data worker's message boundary: the `default:` never-arm (reachable only from an untyped
// sender) and a failed open both have to come back as `streamError`, never as an unhandled rejection
// in a worker nobody is watching. Node stands in for the worker scope — `self` is a postMessage sink.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { flushAsync } from "../../tests/helpers.ts";

const postMessage = vi.fn();
let onmessage: (event: { data: unknown }) => void;

beforeAll(async () => {
  (globalThis as unknown as { self: unknown }).self = { postMessage, onmessage: null };
  await import("./data.worker.ts");
  onmessage = (globalThis as unknown as { self: { onmessage: typeof onmessage } }).self.onmessage;
});

const errors = (): string[] =>
  postMessage.mock.calls
    .map(([message]) => message as { kind: string; message?: string })
    .filter((message) => message.kind === "streamError")
    .map((message) => message.message ?? "");

describe("data worker message routing", () => {
  it("reports an unknown request kind, carrying the payload", () => {
    onmessage({ data: { kind: "nonsense", requestId: 7 } });
    expect(errors().at(-1)).toMatch(/unknown request/);
    expect(errors().at(-1)).toMatch(/nonsense/);
  });

  it("reports a handle no reader recognizes instead of rejecting into the void", async () => {
    onmessage({
      data: {
        kind: "open",
        requestId: 8,
        handle: { kind: "url", url: "https://example.invalid/not-a-dataset" },
        activeField: "|B|",
        layerId: "layer-0",
        port: { close: vi.fn(), postMessage: vi.fn() } as unknown as MessagePort,
      },
    });
    await flushAsync();
    expect(errors().at(-1)).toMatch(/no reader recognized/);
  });

  // A dataset switch tears the stream down and rebuilds it; the UI keeps scrubbing and selecting
  // fields across that gap, so these must land as no-ops rather than as errors nobody can act on.
  it("absorbs a cursor move that arrives before the stream is open", () => {
    const before = errors().length;
    onmessage({ data: { kind: "setCursor", requestId: 9, step: 3 } });
    expect(errors()).toHaveLength(before);
  });

  it("absorbs a field switch that arrives before the stream is open", () => {
    const before = errors().length;
    onmessage({ data: { kind: "setActiveField", requestId: 10, field: "|E|" } });
    expect(errors()).toHaveLength(before);
  });

  it("reports a cache write it cannot land instead of rejecting into the void", async () => {
    onmessage({
      data: { kind: "cacheWrite", requestId: 11, path: "a/b.bin", bytes: new ArrayBuffer(4) },
    });
    await flushAsync();
    const failures = postMessage.mock.calls
      .map(([message]) => message as { kind: string; requestId?: number })
      .filter((message) => message.kind === "error");
    expect(failures.at(-1)?.requestId).toBe(11); // no OPFS in node: it must come back as an error
  });

  it("starts and stops the perf self-report on demand", () => {
    vi.useFakeTimers();
    const samples = (): number =>
      postMessage.mock.calls.filter(([m]) => (m as { kind: string }).kind === "perfSample").length;

    onmessage({ data: { kind: "setPerfActive", requestId: 12, active: true } });
    expect(samples()).toBe(1); // the first sample lands immediately, not one interval later
    vi.advanceTimersByTime(2500);
    expect(samples()).toBeGreaterThan(1);

    const whileActive = samples();
    onmessage({ data: { kind: "setPerfActive", requestId: 13, active: false } });
    vi.advanceTimersByTime(5000);
    expect(samples()).toBe(whileActive);
    vi.useRealTimers();
  });
});
