import { REQUEST_IDS } from "@render/messages.ts";
import { describe, expect, it, vi } from "vitest";
import { installShaderHmr, SHADER_HMR_EVENT, type ShaderHmrEvent } from "./shaderHmr.ts";

// The dev shader-HMR bridge: a fake HMR client stands in for `import.meta.hot` (undefined in
// node), and a recording worker captures the forwarded request. Verifies the event→message contract
// and that the disposer un-wires the exact handler it registered (ViteHotContext.off detaches by
// reference). The worker-side re-import + material swap is a dev-server/GPU concern, exercised by the
// worker integration suites — not here.

describe("installShaderHmr", () => {
  it("forwards a shader-edit event to the worker as a rebuildShader request", () => {
    const hot = { on: vi.fn(), off: vi.fn() };
    const worker = { postMessage: vi.fn() };

    installShaderHmr(worker, hot);
    expect(hot.on).toHaveBeenCalledWith(SHADER_HMR_EVENT, expect.any(Function));

    // Invoke the registered handler as Vite's client would on a watched edit.
    const handler = hot.on.mock.calls[0]?.[1] as (data: ShaderHmrEvent) => void;
    handler({ timestamp: 1717171717 });
    expect(worker.postMessage).toHaveBeenCalledWith({
      kind: "rebuildShader",
      requestId: REQUEST_IDS.shaderHmr,
      timestamp: 1717171717,
    });
  });

  it("un-wires the exact handler it registered on dispose", () => {
    const hot = { on: vi.fn(), off: vi.fn() };
    const dispose = installShaderHmr({ postMessage: vi.fn() }, hot);
    const handler = hot.on.mock.calls[0]?.[1];
    dispose();
    expect(hot.off).toHaveBeenCalledWith(SHADER_HMR_EVENT, handler);
  });

  it("is a no-op when there is no HMR client (production / non-dev)", () => {
    const worker = { postMessage: vi.fn() };
    const dispose = installShaderHmr(worker, undefined);
    dispose(); // must not throw
    expect(worker.postMessage).not.toHaveBeenCalled();
  });
});
