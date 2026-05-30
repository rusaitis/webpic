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

// Layer dependency DAG: the layers each layer is allowed to import from. Enforced by
// scripts/check-boundaries.ts. Same-layer imports are always allowed (see canImport).
export const ALLOWED_IMPORTS: Record<LayerName, readonly LayerName[]> = {
  schema: [],
  containers: ["schema"],
  coordinates: ["containers", "schema"],
  numerics: ["containers"],
  reductions: ["schema", "containers", "coordinates"],
  derived: ["coordinates", "numerics", "containers", "schema"],
  diagnostics: ["coordinates", "containers"],
  gpu: [],
  shaders: [],
  compute: [
    "schema",
    "coordinates",
    "numerics",
    "reductions",
    "shaders",
    "gpu",
    "derived",
    "containers",
  ],
  data: ["schema", "containers", "reductions"],
  remote: ["schema", "containers", "data", "reductions"],
  render: ["schema", "containers", "coordinates", "numerics", "compute", "data", "gpu"],
  store: ["schema", "containers", "compute"],
  // ui also imports the theme module; add it here once that layer/alias exists.
  ui: ["schema", "containers", "store", "remote"],
  app: LAYERS.filter((layer) => layer !== "app"), // composition root: imports everything
  workers: ["coordinates", "numerics", "compute", "data", "containers"],
  embed: [
    "schema",
    "containers",
    "coordinates",
    "numerics",
    "reductions",
    "derived",
    "diagnostics",
    "compute",
    "data",
  ],
};

export function canImport(from: LayerName, to: LayerName): boolean {
  return from === to || ALLOWED_IMPORTS[from].includes(to);
}
