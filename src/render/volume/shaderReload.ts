import type { RaymarchMaterialBuilder } from "./raymarchScene.ts";

// Dev-only shader hot-reload: re-import the raymarch scene module with a cache-busting query so
// the Vite dev server re-transforms the edited WGSL/TSL, and hand back its FRESH material builder. The
// worker applies it over each volume layer's preserved graph (uploaded texture + uniforms), so the edit
// re-renders without a reload or a 64 MiB re-upload.
//
// Isolated from worker.ts so the worker stays free of the `@vite-ignore` dynamic import, and so the
// reload flow is mockable in node (the dev server + three/webgpu are browser-only). Reached only when
// `import.meta.env.DEV` (dead-code-eliminated from the prod worker bundle).

// Re-import `raymarchScene.ts` fresh (cache-busted by `timestamp`) and return its material builder.
export async function loadFreshRaymarchBuilder(
  timestamp: number,
): Promise<RaymarchMaterialBuilder> {
  // The `?t=` query makes this a distinct module instance (bypasses the import cache — Vite's own
  // invalidation convention); @vite-ignore stops Vite from trying to pre-resolve the templated
  // specifier. The static imports inside the fresh module (volumeTexture/normalization/…) resolve to
  // the already-evaluated instances, so the rebuilt material reuses the live texture/uniform nodes.
  const fresh = (await import(/* @vite-ignore */ `./raymarchScene.ts?t=${timestamp}`)) as {
    readonly buildRaymarchMaterial: RaymarchMaterialBuilder;
  };
  return fresh.buildRaymarchMaterial;
}
