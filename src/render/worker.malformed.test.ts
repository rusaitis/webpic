// The worker's wire boundary under bad input: an unknown `kind` (the `default:` never-arm, reachable
// only from an untyped sender) and a field payload whose buffer size disagrees with its dtype/shape.
// Both must come back as an `error` response naming the offender — never a silent no-op, and never a
// texture uploaded from a reinterpreted buffer. Mocks come from tests/renderWorkerHarness.ts.

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { RenderWorkerRequest } from "./messages.ts";

const h = await vi.hoisted(() =>
  import("../../tests/renderWorkerHarness.ts").then((m) => m.createWorkerHarness()),
);

vi.mock("@gpu", () => h.gpu);
vi.mock("./runtime/renderer.ts", async (original) => ({
  ...(await original<typeof import("./runtime/renderer.ts")>()),
  installRenderer: h.installRenderer,
}));
vi.mock("./field/raymarchScene.ts", () => ({ createRaymarchScene: h.createRaymarchScene }));
vi.mock("./field/sliceScene.ts", () => ({ createSliceScene: h.createSliceScene }));
vi.mock("./debugTriangle.ts", () => ({ createDebugTriangle: h.createDebugTriangle }));

const postMessage = vi.fn();
let onmessage: (event: { data: unknown }) => void;

beforeAll(async () => {
  (globalThis as unknown as { self: unknown }).self = { postMessage };
  await import("./worker.ts");
  onmessage = (globalThis as unknown as { self: { onmessage: typeof onmessage } }).self.onmessage;
  onmessage({
    data: {
      kind: "init",
      requestId: 1,
      canvas: {} as unknown as OffscreenCanvas,
      width: 8,
      height: 8,
      devicePixelRatio: 1,
    } satisfies RenderWorkerRequest,
  });
  await vi.waitFor(() => expect(h.installRenderer).toHaveBeenCalledTimes(1));
});

afterAll(() => {
  delete (globalThis as unknown as { self?: unknown }).self;
});

const lastError = (): { kind: string; requestId: number; message: string } | undefined => {
  const calls = postMessage.mock.calls.map(([message]) => message as { kind: string });
  return calls.filter((message) => message.kind === "error").at(-1) as never;
};

it("answers an unknown request kind with an error carrying the payload", async () => {
  onmessage({ data: { kind: "nonsense", requestId: 99, detail: "unroutable" } });
  await vi.waitFor(() => expect(lastError()?.requestId).toBe(99));
  expect(lastError()?.message).toMatch(/unknown request/);
  expect(lastError()?.message).toMatch(/nonsense/); // the offending payload, not just its shape
});

it("rejects a field payload whose buffer disagrees with its dtype and shape", async () => {
  const field = { buffer: new Float32Array(4).buffer, dtype: "f64" as const, shape: [2, 2, 2] };
  onmessage({
    data: {
      kind: "upsertLayer",
      requestId: 100,
      id: "layer-bad",
      params: { layerKind: "volume" },
      field,
      colormap: "inferno",
      scale: "linear",
      opacity: 1,
    } satisfies RenderWorkerRequest,
  });
  await vi.waitFor(() => expect(lastError()?.requestId).toBe(100));
  expect(lastError()?.message).toMatch(
    /decodeFieldPayload: f64 buffer is 16 bytes, shape \[2, 2, 2\] needs 64/,
  );
});
