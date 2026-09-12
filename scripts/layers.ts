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
//
// Each row is what the layer actually imports today, not what it might. A row wider than the code
// describes an intention rather than an architecture, so a reserved edge carries the reason it is
// held open — the same discipline the reserved layers' `STAGED:` headers follow.
export const ALLOWED_IMPORTS: Record<LayerName, readonly LayerName[]> = {
  schema: [],
  containers: ["schema"],
  coordinates: ["schema", "containers"],
  numerics: ["schema", "containers"],
  reductions: ["schema"],
  derived: ["schema"],
  // Reserved: the analyzer leg's diagnostics are grid operators over a dataset (DESIGN §Data layer).
  diagnostics: ["schema", "containers", "coordinates"],
  gpu: [],
  shaders: [],
  compute: ["schema", "containers", "coordinates", "numerics", "derived", "shaders", "gpu"],
  data: ["schema", "containers"],
  // Reserved: the pypic.server client decodes into the same containers the readers produce.
  remote: ["schema", "containers", "data"],
  // Reserved: `compute` activates when the dispatcher can route GPU work from the render worker
  // (compute/backends/webgpu is STAGED on the same seam).
  render: ["schema", "containers", "reductions", "data", "gpu", "compute"],
  store: ["schema", "containers", "reductions", "compute"],
  ui: ["schema", "containers", "store"],
  app: LAYERS.filter((layer) => layer !== "app"), // composition root: imports everything
  workers: ["schema", "containers", "compute", "data"],
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
