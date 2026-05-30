import { join } from "node:path";
import { LAYERS } from "./layers.ts";

export interface LayerAlias {
  readonly find: string;
  readonly replacement: string;
}

// Vite/Vitest resolve.alias entries: `@<layer>` and `@<layer>/sub` both map into
// src/<layer>. No layer name is a prefix of another, so prefix matching is unambiguous.
export function layerAliases(rootDir: string): LayerAlias[] {
  return LAYERS.map((layer) => ({
    find: `@${layer}`,
    replacement: join(rootDir, "src", layer),
  }));
}
