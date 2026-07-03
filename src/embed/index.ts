/**
 * `@webpic/embed` — the headless public library surface (DESIGN §Public library export):
 * pypic-mirrored schema + containers, the pure math layers, the compute dispatcher, and the
 * Zarr readers/writers. No `render`/`ui`/`app`/`store`/`remote` — a downstream consumer (e.g.
 * a Jupyter widget) imports the math + data layers without dragging in Three.js or the DOM.
 *
 * @packageDocumentation
 */

export * from "@compute/backend.ts";
export * from "@compute/field.ts";
export * from "@compute/recipe.ts";
export * from "@compute/recipes.generated.ts";
export * from "@compute/traceField.ts";
export * from "@containers";
export * from "@coordinates";
export * from "@data/readers/_protocols.ts";
export * from "@data/readers/_registry.ts";
export * from "@data/readers/builtins.ts";
export * from "@data/readers/synthetic.ts";
export * from "@data/readers/zarr.ts";
export * from "@data/writers/zarr.ts";
export * from "@derived";
export * from "@diagnostics";
export * from "@numerics";
export * from "@reductions";
export * from "@schema";
