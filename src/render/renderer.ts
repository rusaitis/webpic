import type { Camera, Object3D } from "three";
import {
  Color,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  RGBAFormat,
  UnsignedByteType,
} from "three";
import { texture, uv } from "three/tsl";
import { NodeMaterial, WebGPURenderer } from "three/webgpu";
import { BACKGROUND_COLOR } from "./constants.ts";
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

// One renderable layer in a composite: a root Object3D paired with the camera its projection needs
// (perspective for volumes, orthographic for slices). Draw order = array order.
export interface CompositeItem {
  readonly scene: Object3D;
  readonly camera: Camera;
}

export interface InstalledRenderer {
  readonly renderer: WebGPURenderer;
  renderOnce(scene: Object3D, camera: Camera): void;
  readPixels(scene: Object3D, camera: Camera): Promise<Uint8Array>;
  /** Composite the visible layers (draw order + per-layer material opacity) onto the swapchain. */
  renderComposite(items: readonly CompositeItem[]): void;
  /** Deterministic readback of the composited layers — the testable compositing primitive. */
  readCompositePixels(items: readonly CompositeItem[]): Promise<Uint8Array>;
  dispose(): void;
}

export async function installRenderer(opts: RendererOptions): Promise<InstalledRenderer> {
  const renderer = new WebGPURenderer({
    canvas: opts.canvas,
    antialias: false, // MSAA resolve is a nondeterminism source; off for parity
    ...(opts.device ? { device: opts.device } : {}),
  });
  renderer.setSize(opts.width, opts.height, false); // no style: OffscreenCanvas has none
  // The scenes no longer carry a background; the renderer owns the one clear color so layers
  // composite over a single background and the boot/parity frame is unchanged.
  renderer.setClearColor(new Color(BACKGROUND_COLOR), 1);
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

  // Lazily built only when a ≥2-layer swapchain composite first occurs (single-layer is the common
  // case and uses the direct path). compositeTarget accumulates the layers; the quad presents it.
  let compositeTarget: RenderTarget | undefined;
  let presentQuad: Mesh | undefined;
  let presentCamera: OrthographicCamera | undefined;

  const ensurePresent = (): { target: RenderTarget; quad: Mesh; camera: OrthographicCamera } => {
    if (compositeTarget === undefined || presentQuad === undefined || presentCamera === undefined) {
      compositeTarget = new RenderTarget(opts.width, opts.height, {
        format: RGBAFormat,
        type: UnsignedByteType,
      });
      const material = new NodeMaterial();
      material.colorNode = texture(compositeTarget.texture, uv());
      material.depthTest = false;
      material.depthWrite = false;
      presentQuad = new Mesh(new PlaneGeometry(2, 2), material);
      presentCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 2);
      presentCamera.position.z = 1;
    }
    return { target: compositeTarget, quad: presentQuad, camera: presentCamera };
  };

  // Clear once to the renderer clear color, then accumulate each item with autoClear off. A depth
  // clear between items makes draw order (not incomparable cross-camera depths) authoritative.
  // Leaves `target` bound (callers read it back or present from it, then unbind), matching the
  // proven readPixels order; autoClear is restored so the next direct render clears as usual.
  const compositeInto = (target: RenderTarget | null, items: readonly CompositeItem[]): void => {
    renderer.setRenderTarget(target);
    renderer.autoClear = true;
    renderer.clear();
    renderer.autoClear = false;
    for (const item of items) {
      renderer.clearDepth();
      renderer.render(item.scene, item.camera);
    }
    renderer.autoClear = true;
  };

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
    renderComposite(items) {
      // ≤1 layer: the direct swapchain path (identical to renderOnce, byte-for-byte with today).
      if (items.length <= 1) {
        renderer.setRenderTarget(null);
        const item = items[0];
        if (item !== undefined) renderer.render(item.scene, item.camera);
        else renderer.clear();
        return;
      }
      // ≥2 layers: composite offscreen (the swapchain blit overwrites rather than blends across
      // renders), then present the result with a single output render.
      const { target, quad, camera } = ensurePresent();
      compositeInto(target, items);
      renderer.setRenderTarget(null);
      renderer.render(quad, camera);
    },
    async readCompositePixels(items) {
      compositeInto(readTarget, items); // leaves readTarget bound
      const data = await renderer.readRenderTargetPixelsAsync(
        readTarget,
        0,
        0,
        opts.width,
        opts.height,
      );
      renderer.setRenderTarget(null);
      return toTransferablePixels(data);
    },
    dispose() {
      // The gpu-layer device is intentionally NOT destroyed here — its lifetime
      // belongs to whoever called installGpu().
      readTarget.dispose();
      compositeTarget?.dispose();
      presentQuad?.geometry.dispose();
      if (presentQuad?.material instanceof NodeMaterial) presentQuad.material.dispose();
      renderer.dispose();
    },
  };
}
