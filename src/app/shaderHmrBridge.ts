import { REQUEST_IDS, type RenderWorkerRequest } from "@render/messages.ts";

// Dev-only shader HMR bridge. The render worker imports the raymarch scene factory but isn't
// HMR-self-accepting, so an edit to its WGSL/TSL would bubble to a full page reload, losing the camera
// pose and the uploaded volume. The `webpic:shader-hmr` Vite plugin intercepts that edit and fires a
// custom event; this forwards it to the worker as `rebuildShader`, which swaps the material in place.
// `import.meta.hot` is undefined in production and main.ts only dynamic-imports this behind it, so
// none of it ships in the prod bundle.

// The custom HMR event the Vite plugin emits on a raymarch-shader edit (kept in sync with the literal
// in vite.config.ts's shaderHmr plugin — a stable protocol string, not imported across the config seam).
export const SHADER_HMR_EVENT = "webpic:shader-hmr";

// Payload of `SHADER_HMR_EVENT`: Vite's update timestamp, used to cache-bust the worker's
// re-import so it pulls the freshly transformed module.
export interface ShaderHmrEvent {
  readonly timestamp: number;
}

// Just the HMR-client surface the bridge touches — injectable so the wiring is testable in node (where
// the real `import.meta.hot` is undefined). Defaults to `import.meta.hot` at the call site.
type HotLike = Pick<NonNullable<ImportMeta["hot"]>, "on" | "off">;

// Wire the Vite HMR client's shader-edit event to the worker's `rebuildShader` request. Returns a
// disposer; a no-op (and no listener) when there's no HMR client (production / non-dev).
export function installShaderHmr(
  worker: Pick<Worker, "postMessage">,
  hot: HotLike | undefined = import.meta.hot,
): () => void {
  if (hot === undefined) return () => {};
  const onShaderEdit = (data: ShaderHmrEvent): void => {
    const request: RenderWorkerRequest = {
      kind: "rebuildShader",
      requestId: REQUEST_IDS.shaderHmr,
      timestamp: data.timestamp,
    };
    worker.postMessage(request);
  };
  hot.on(SHADER_HMR_EVENT, onShaderEdit);
  return () => hot.off(SHADER_HMR_EVENT, onShaderEdit);
}
