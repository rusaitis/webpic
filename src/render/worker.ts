import { getDevice, installGpu } from "@gpu";
import type { RenderWorkerRequest, RenderWorkerResponse } from "./messages.ts";
import { type InstalledRenderer, installRenderer } from "./renderer.ts";
import { createTestScene, type TestScene } from "./scene.ts";

// Worker-scope view of `self`. The DOM lib types `self` as Window (whose
// postMessage wants a targetOrigin), so narrow it to the dedicated-worker surface.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<RenderWorkerRequest>) => void) | null;
  postMessage(message: RenderWorkerResponse, transfer?: Transferable[]): void;
};

let gpu: { dispose: () => void } | undefined;
let renderer: InstalledRenderer | undefined;
let testScene: TestScene | undefined;
let dims = { width: 0, height: 0 };

async function init(request: Extract<RenderWorkerRequest, { kind: "init" }>): Promise<void> {
  gpu = await installGpu();
  renderer = await installRenderer({
    canvas: request.canvas,
    width: request.width,
    height: request.height,
    device: getDevice(),
  });
  testScene = createTestScene();
  dims = { width: request.width, height: request.height };
  renderer.renderOnce(testScene.scene, testScene.camera);
  ctx.postMessage({ kind: "ready", requestId: request.requestId });
}

async function renderFrame(
  request: Extract<RenderWorkerRequest, { kind: "renderFrame" }>,
): Promise<void> {
  if (renderer === undefined || testScene === undefined) {
    throw new Error("renderFrame before init");
  }
  const pixels = await renderer.readPixels(testScene.scene, testScene.camera);
  // Freshly allocated readback buffer (never shared) — safe to transfer.
  const buffer = pixels.buffer as ArrayBuffer;
  ctx.postMessage(
    {
      kind: "frame",
      requestId: request.requestId,
      width: dims.width,
      height: dims.height,
      pixels: buffer,
    },
    [buffer],
  );
}

function handle(request: RenderWorkerRequest): Promise<void> {
  switch (request.kind) {
    case "init":
      return init(request);
    case "renderFrame":
      return renderFrame(request);
    default: {
      const unreachable: never = request;
      return Promise.reject(new Error(`unknown request: ${JSON.stringify(unreachable)}`));
    }
  }
}

ctx.onmessage = (event) => {
  const request = event.data;
  handle(request).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.postMessage({ kind: "error", requestId: request.requestId, message });
  });
};

export function dispose(): void {
  testScene?.dispose();
  renderer?.dispose();
  gpu?.dispose();
}
