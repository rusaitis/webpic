import type { Camera, Object3D } from "three";
import { RenderTarget, RGBAFormat, UnsignedByteType } from "three";
import { WebGPURenderer } from "three/webgpu";
import { toTransferablePixels } from "./pixels.ts";

export interface RendererOptions {
  // OffscreenCanvas only: the worker receives a transferred one, the parity test
  // makes its own. Avoids an HTMLCanvasElement (DOM-lib) dependency so this module
  // also type-checks in a worker context.
  readonly canvas: OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  // Inject the gpu/ singleton device so render + compute share one device and one
  // device.lost recovery path. Omit to let Three self-acquire (e.g. headless embed).
  // A GPUDevice can't transfer across threads, so a worker installs its own first.
  readonly device?: GPUDevice;
}

export interface InstalledRenderer {
  readonly renderer: WebGPURenderer;
  renderOnce(scene: Object3D, camera: Camera): void;
  readPixels(scene: Object3D, camera: Camera): Promise<Uint8Array>;
  dispose(): void;
}

export async function installRenderer(opts: RendererOptions): Promise<InstalledRenderer> {
  const renderer = new WebGPURenderer({
    canvas: opts.canvas,
    antialias: false, // MSAA resolve is a nondeterminism source; off for parity
    ...(opts.device ? { device: opts.device } : {}),
  });
  renderer.setSize(opts.width, opts.height, false); // no style: OffscreenCanvas has none
  await renderer.init();

  // Readback target: an UnsignedByte RGBA texture both paths read identically,
  // sidestepping any swapchain-presentation differences between worker and main.
  // Annotated as the bare RenderTarget: @types/three treats the generic as
  // invariant, so the inferred RenderTarget<Texture<unknown>> would not match
  // readRenderTargetPixelsAsync's RenderTarget parameter without this.
  const readTarget: RenderTarget = new RenderTarget(opts.width, opts.height, {
    format: RGBAFormat,
    type: UnsignedByteType,
  });

  return {
    renderer,
    renderOnce(scene, camera) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    async readPixels(scene, camera) {
      renderer.setRenderTarget(readTarget);
      renderer.render(scene, camera);
      const data = await renderer.readRenderTargetPixelsAsync(
        readTarget,
        0,
        0,
        opts.width,
        opts.height,
      );
      renderer.setRenderTarget(null);
      // Compact, offset-0 buffer so the worker can transfer pixels.buffer wholesale.
      return toTransferablePixels(data);
    },
    dispose() {
      // The gpu-layer device is intentionally NOT destroyed here — its lifetime
      // belongs to whoever called installGpu().
      readTarget.dispose();
      renderer.dispose();
    },
  };
}
