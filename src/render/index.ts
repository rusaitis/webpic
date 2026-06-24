// The render layer's public barrel is its worker-message contract — the only render surface app/
// tests consume cross-layer (everything else is render-internal and imported via @render/* subpaths).
export type {
  CameraPose,
  MarkerConfig,
  OverlayAxis,
  RenderWorkerRequest,
  RenderWorkerResponse,
  SceneOverlayConfig,
  WindowLevel,
} from "./messages.ts";
