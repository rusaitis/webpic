export const LAYERS = [
  "schema",
  "containers",
  "coordinates",
  "numerics",
  "reductions",
  "derived",
  "diagnostics",
  "gpu",
  "shaders",
  "compute",
  "data",
  "remote",
  "render",
  "store",
  "ui",
  "app",
  "workers",
  "embed",
] as const;

export type LayerName = (typeof LAYERS)[number];
