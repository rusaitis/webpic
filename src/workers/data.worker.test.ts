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
});
