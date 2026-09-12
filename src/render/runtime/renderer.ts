import { releaseAlloc, trackAlloc } from "@gpu/vramLedger.ts";
import type { Camera, Object3D } from "three";
import { Color, RenderTarget, RGBAFormat, UnsignedByteType, Vector2 } from "three";
import { texture, uv } from "three/tsl";
import { NodeMaterial, QuadMesh, WebGPURenderer } from "three/webgpu";
import { BACKGROUND_COLOR } from "../constants.ts";
import { compactPaddedRows, toTransferablePixels } from "./pixels.ts";

export interface RendererOptions {
  // OffscreenCanvas only: the worker receives a transferred one, the parity test
  // makes its own. Avoids an HTMLCanvasElement (DOM-lib) dependency so this module
  // also type-checks in a worker context.
  readonly canvas: OffscreenCanvas;
  // Logical (CSS) pixel size; the drawing buffer is this × devicePixelRatio.
  readonly width: number;
  readonly height: number;
  // Drawing-buffer scale (1 in the parity test / headless embed; window.devicePixelRatio live).
  readonly devicePixelRatio?: number;
  // Inject the gpu/ singleton device so render + compute share one device and one
  // device.lost recovery path. Omit to let Three self-acquire (e.g. headless embed).
  // A GPUDevice can't transfer across threads, so a worker installs its own first.
  readonly device?: GPUDevice;
}

// One renderable layer in a composite: a root Object3D paired with the camera its projection needs
// (perspective for volumes, orthographic for slices). Draw order = array order.
export interface CompositeDrawItem {
  readonly scene: Object3D;
  readonly camera: Camera;
}

export interface InstalledRenderer {
  readonly renderer: WebGPURenderer;
  readPixels(scene: Object3D, camera: Camera): Promise<Uint8Array>;
  // Composite the visible layers (draw order + per-layer material opacity) onto the swapchain.
  renderComposite(items: readonly CompositeDrawItem[]): void;
  // Pre-create every pipeline `renderComposite(items)` would need, off the render path.
  compileComposite(items: readonly CompositeDrawItem[]): Promise<void>;
  // Deterministic readback of the composited layers — the testable compositing primitive.
  readCompositePixels(items: readonly CompositeDrawItem[]): Promise<Uint8Array>;
  // The readback target's physical size (logical × DPR) — the dimensions readCompositePixels fills.
  readbackSize(): { width: number; height: number };
  // Resize the swapchain + readback/composite targets to a new logical size and DPR.
  setSize(width: number, height: number, devicePixelRatio?: number): void;
  // Scale the swapchain drawing buffer (interaction-time quality). Readback stays full-res.
  setRenderScale(scale: number): void;
  dispose(): void;
}

export async function installRenderer(options: RendererOptions): Promise<InstalledRenderer> {
  const renderer = new WebGPURenderer({
    canvas: options.canvas,
    antialias: false, // MSAA resolve is a nondeterminism source; off for parity
    // No trackTimestamp: it writes timestampWrites into *every* render pass incl. the swapchain
    // present, and the per-frame resolveTimestampsAsync/mapAsync loses the device on Metal (the
    // adaptive timer demotes on garbage values, not on a device-lost throw). GPU timing is
    // wall-clock instead (render/frameTimer.ts) — no querySet, no mapAsync.
    ...(options.device ? { device: options.device } : {}),
  });
  let logical = { width: options.width, height: options.height };
  let dpr = options.devicePixelRatio ?? 1;
  let renderScale = 1; // interaction-time swapchain scale; never applied to the readback target

  renderer.setPixelRatio(dpr); // before setSize: drawing buffer = logical × DPR
  renderer.setSize(logical.width, logical.height, false); // no style: OffscreenCanvas has none
  // No scene carries a background; the renderer owns the one clear color so layers
  // composite over a single background and the boot/parity frame is unchanged.
  renderer.setClearColor(new Color(BACKGROUND_COLOR), 1);
  await renderer.init();

  // Swapchain + composite targets track the *drawing-buffer* (physical) size — logical × DPR ×
  // renderScale. setPixelRatio folds DPR (and the interaction scale) into this.
  const drawingBuffer = (): { width: number; height: number } => {
    const size = renderer.getDrawingBufferSize(new Vector2());
    return { width: size.x, height: size.y };
  };
  let buffer = drawingBuffer();

  // RGBA8 UnsignedByte render targets = 4 B/texel; track them in the VRAM ledger (perf HUD).
  const trackRt = (key: string, target: RenderTarget): void =>
    trackAlloc(key, target.width * target.height * 4);

  const applyBufferSize = (): void => {
    renderer.setPixelRatio(dpr * renderScale);
    renderer.setSize(logical.width, logical.height, false);
    buffer = drawingBuffer();
    compositeTarget?.setSize(buffer.width, buffer.height);
    if (compositeTarget !== undefined) trackRt("rt:composite", compositeTarget);
  };

  // The readback target is pinned to the FULL logical × DPR size (never × renderScale), so the
  // deterministic readback/parity paths are structurally unaffected by interaction-time scaling.
  // Matches three's setSize rounding so readback and swapchain agree at scale 1.
  const fullSize = (): { width: number; height: number } => ({
    width: Math.floor(logical.width * dpr),
    height: Math.floor(logical.height * dpr),
  });

  // Readback target: an UnsignedByte RGBA texture both paths read identically,
  // sidestepping any swapchain-presentation differences between worker and main.
  // Annotated as the bare RenderTarget: @types/three treats the generic as
  // invariant, so the inferred RenderTarget<Texture<unknown>> would not match
  // readRenderTargetPixelsAsync's RenderTarget parameter without this.
  const readTarget: RenderTarget = new RenderTarget(fullSize().width, fullSize().height, {
    format: RGBAFormat,
    type: UnsignedByteType,
  });
  trackRt("rt:read", readTarget);

  // Lazily built only when a ≥2-layer swapchain composite first occurs (single-layer is the common
  // case and uses the direct path). compositeTarget accumulates the layers; the quad presents it.
  // Both deliberately persist after the composite drops back to ≤1 layer (until dispose): freeing
  // them would make the next 2-layer frame rebuild target + material and stall on a synchronous
  // pipeline creation — warm-compile only runs on layer upserts.
  let compositeTarget: RenderTarget | undefined;
  let presentQuad: QuadMesh | undefined;

  const ensurePresent = (): { target: RenderTarget; quad: QuadMesh } => {
    if (compositeTarget === undefined || presentQuad === undefined) {
      compositeTarget = new RenderTarget(buffer.width, buffer.height, {
        format: RGBAFormat,
        type: UnsignedByteType,
      });
      trackRt("rt:composite", compositeTarget);
      // Prime the fresh RenderTarget before the present material samples it: WebGPU/Metal validates
      // the binding at shader-compile and an unwritten target reads back as the magenta sentinel.
      renderer.setRenderTarget(compositeTarget);
      renderer.clear();
      renderer.setRenderTarget(null);
      const material = new NodeMaterial();
      material.colorNode = texture(compositeTarget.texture, uv());
      material.depthTest = false;
      material.depthWrite = false;
      // QuadMesh, not a PlaneGeometry quad: WebGPU render targets sample with v=0 at the image
      // top (WGSL applies no GL-era flip), while PlaneGeometry's GL-convention uvs (v=0 bottom)
      // presented the whole composited frame upside-down. QuadMesh's fullscreen triangle encodes
      // the correct per-backend convention — it's what three's own RenderPipeline presents with.
      presentQuad = new QuadMesh(material);
    }
    return { target: compositeTarget, quad: presentQuad };
  };

  // Clear once to the renderer clear color, then accumulate each item with autoClear off. A depth
  // clear between items makes draw order (not incomparable cross-camera depths) authoritative.
  // Leaves `target` bound (callers read it back or present from it, then unbind), matching the
  // proven readPixels order; autoClear is restored so the next direct render clears as usual.
  const compositeInto = (
    target: RenderTarget | null,
    items: readonly CompositeDrawItem[],
  ): void => {
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

  // Read whatever was just drawn into readTarget, unbind, and hand back a compact offset-0 buffer
  // so the worker can transfer pixels.buffer wholesale. Both read paths end here; they differ only
  // in what they draw first.
  const drainReadTarget = async (): Promise<Uint8Array> => {
    const data = await renderer.readRenderTargetPixelsAsync(
      readTarget,
      0,
      0,
      readTarget.width,
      readTarget.height,
    );
    renderer.setRenderTarget(null);
    return toTransferablePixels(compactPaddedRows(data, readTarget.width, readTarget.height));
  };

  return {
    renderer,
    async readPixels(scene, camera) {
      renderer.setRenderTarget(readTarget);
      renderer.render(scene, camera);
      return drainReadTarget();
    },
    renderComposite(items) {
      // ≤1 layer: the direct swapchain path (the common single-layer case).
      if (items.length <= 1) {
        renderer.setRenderTarget(null);
        const item = items[0];
        if (item !== undefined) renderer.render(item.scene, item.camera);
        else renderer.clear();
        return;
      }
      // ≥2 layers: composite offscreen (the swapchain blit overwrites rather than blends across
      // renders), then present the result with a single output render.
      const { target, quad } = ensurePresent();
      compositeInto(target, items);
      renderer.setRenderTarget(null);
      quad.render(renderer);
    },
    async compileComposite(items) {
      // Warm with createRenderPipelineAsync against the same render-target contexts renderComposite
      // will draw into — pipelines are cached per context (swapchain bgra8 vs composite rgba8 are
      // distinct pipelines) — so a new scene's first visible frame neither stalls on the sync
      // createRenderPipeline nor draws half-compiled.
      if (items.length <= 1) {
        renderer.setRenderTarget(null);
        const item = items[0];
        if (item !== undefined) await renderer.compileAsync(item.scene, item.camera);
        return;
      }
      const { target, quad } = ensurePresent();
      for (const item of items) {
        // Re-assert the target before each await: an interleaved render() resets it to null.
        renderer.setRenderTarget(target);
        await renderer.compileAsync(item.scene, item.camera);
      }
      renderer.setRenderTarget(null);
      await renderer.compileAsync(quad, quad.camera);
    },
    async readCompositePixels(items) {
      compositeInto(readTarget, items); // leaves readTarget bound
      return drainReadTarget();
    },
    readbackSize() {
      return { width: readTarget.width, height: readTarget.height };
    },
    setSize(width, height, devicePixelRatio) {
      logical = { width, height };
      if (devicePixelRatio !== undefined) dpr = devicePixelRatio;
      applyBufferSize();
      readTarget.setSize(fullSize().width, fullSize().height);
      trackRt("rt:read", readTarget);
    },
    setRenderScale(scale) {
      if (scale === renderScale) return;
      renderScale = scale;
      applyBufferSize(); // pipeline cache keys ignore buffer size — no recompile, just a realloc
    },
    dispose() {
      // The gpu-layer device is intentionally NOT destroyed here — its lifetime
      // belongs to whoever called installGpu().
      readTarget.dispose();
      compositeTarget?.dispose();
      releaseAlloc("rt:read");
      releaseAlloc("rt:composite");
      // QuadMesh's geometry is a module-level singleton shared by every QuadMesh — never dispose it.
      if (presentQuad?.material instanceof NodeMaterial) presentQuad.material.dispose();
      renderer.dispose();
    },
  };
}
