// The display loop: an on-demand requestAnimationFrame painter. requestRender sets a dirty flag the
// loop drains; with no rAF present (Node) it paints synchronously instead, preserving the one-shot
// behavior. The loop owns no renderable state — it calls the host to paint (plain or GPU-timed),
// tick the marker easing, and advance the quality settle ramp, each gated so on-demand frames stay
// cheap. A deterministic readback (renderFrame) borrows the renderer, so beginReadback/endReadback
// pause the swapchain render across that async gap and re-dirty afterward.
export interface RenderLoopHost {
  /** Is the renderer built? (false pre-init / mid-rebuild — the loop idles.) */
  hasRenderer(): boolean;
  /** Is the GPU device lost? (the loop pauses between loss and restore.) */
  isDeviceLost(): boolean;
  /** Paint the swapchain (renderComposite of the current paint items). */
  paint(): void;
  /** Paint with the per-frame GPU timer bracketed around it (continuous measurement only). */
  paintTimed(): void;
  /** Advance per-frame animations (marker easing); true while still animating, so keep painting. */
  tickAnimations(frameTimeMs: number): boolean;
  /** Advance the quality settle ramp one level — runs once per painted on-demand frame. */
  advanceQuality(): void;
  reportFault(error: unknown): void;
  /** A clean frame re-arms the deduped error reporting. */
  clearError(): void;
}

export interface RenderLoop {
  /** The single repaint entry point handlers call; paints synchronously when no loop is running. */
  requestRender(): void;
  start(): void;
  stop(): void;
  /** Is the rAF loop live? (drives the quality controller's Node-collapse predicate.) */
  isRunning(): boolean;
  /** Pause the loop's paint across a deterministic readback that borrows the renderer. */
  beginReadback(): void;
  /** Resume and re-dirty — repaint the swapchain the readback borrowed. */
  endReadback(): void;
  setContinuous(continuous: boolean): void;
}

export function createRenderLoop(host: RenderLoopHost): RenderLoop {
  let needsRender = false; // on-demand: the loop paints only when something changed
  let rafId: number | undefined; // undefined ⇒ no loop running
  let isReadbackInFlight = false; // pauses the loop across a deterministic readPixels
  let isContinuous = false; // diagnostics: force every-frame repaints for sustained GPU timing

  // The single repaint entry point. Sets the dirty flag for the loop; if no loop is running (Node, or
  // the init boot paint before start()), renders synchronously instead.
  function requestRender(): void {
    needsRender = true;
    if (rafId === undefined && host.hasRenderer() && !host.isDeviceLost()) {
      host.paint();
      needsRender = false;
    }
  }

  function renderTick(frameTimeMs: number): void {
    // Reschedule first so a throwing frame can't permanently strand the loop.
    rafId = requestAnimationFrame(renderTick);
    if (isReadbackInFlight || !host.hasRenderer() || host.isDeviceLost()) return;
    // Advance the marker's hover/pulse/active easing (cheap, alloc-free) and keep painting while it
    // animates. It only dirties needsRender while easing, then the on-demand loop falls back to idle.
    if (host.tickAnimations(frameTimeMs)) needsRender = true;
    // Continuous mode repaints every frame for sustained GPU timing; otherwise paint only on change.
    if (!needsRender && !isContinuous) return;
    needsRender = false;
    try {
      // GPU timing only while measuring (continuous): its onSubmittedWorkDone bracket is a GPU sync,
      // so on-demand interactive frames skip it entirely and stay smooth.
      if (isContinuous) host.paintTimed();
      else host.paint();
      host.clearError();
      // Each settle level paints exactly one frame: advancing re-arms needsRender until the ramp
      // lands at full, where the level stops changing and the loop goes quiet.
      host.advanceQuality();
    } catch (error) {
      // A single bad frame (transient validation, mid-rebuild sample) must not kill the loop;
      // on-demand mode won't re-enter until the next requestRender, so this self-rate-limits.
      host.reportFault(error);
    }
  }

  return {
    requestRender,
    start() {
      if (rafId !== undefined) return; // idempotent
      if (typeof requestAnimationFrame !== "function") return; // Node: requestRender paints synchronously
      rafId = requestAnimationFrame(renderTick);
    },
    stop() {
      if (rafId !== undefined && typeof cancelAnimationFrame === "function")
        cancelAnimationFrame(rafId);
      rafId = undefined;
    },
    isRunning: () => rafId !== undefined,
    beginReadback() {
      isReadbackInFlight = true;
    },
    endReadback() {
      isReadbackInFlight = false;
      needsRender = true; // repaint the swapchain the readback borrowed the renderer from
    },
    setContinuous(continuous) {
      isContinuous = continuous;
      if (isContinuous) needsRender = true;
    },
  };
}
