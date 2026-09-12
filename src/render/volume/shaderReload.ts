import type { buildRaymarchMaterial, RaymarchMaterialBuilder } from "./raymarchScene.ts";

// Dev-only shader hot-reload: re-import the raymarch scene module with a cache-busting query so the
// Vite dev server re-transforms the edited WGSL/TSL, and hand back its FRESH material builder. The
// worker applies it over each volume layer's preserved graph, so the edit re-renders without a reload
// or a 64 MiB re-upload. Isolated from worker.ts so the worker stays free of the `@vite-ignore`
// dynamic import and the flow is mockable in node. Reached only when `import.meta.env.DEV`, so it is
// dead-code-eliminated from the prod worker bundle.

// Re-import `raymarchScene.ts` fresh (cache-busted by `timestamp`) and return its material builder.
export async function loadFreshRaymarchBuilder(
  timestamp: number,
): Promise<RaymarchMaterialBuilder> {
  // The `?t=` query makes this a distinct module instance (bypasses the import cache — Vite's own
  // invalidation convention); @vite-ignore stops Vite from trying to pre-resolve the templated
  // specifier. The static imports inside the fresh module (volumeTexture/normalization/…) resolve to
  // the already-evaluated instances, so the rebuilt material reuses the live texture/uniform nodes.
  // `typeof buildRaymarchMaterial` over a hand-written shape: the cast then tracks the real export,
  // and the type-only import keeps the name statically reachable for the dead-code check, which
  // cannot see through a templated specifier. Type-only, so three/webgpu stays out of the node path.
  const fresh = (await import(/* @vite-ignore */ `./raymarchScene.ts?t=${timestamp}`)) as {
    readonly buildRaymarchMaterial: typeof buildRaymarchMaterial;
  };
  return fresh.buildRaymarchMaterial;
}
