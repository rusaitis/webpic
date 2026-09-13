// The `@embed` public surface for this layer (DESIGN §Public library export) — a wholesale
// re-export, so it carries generated modules no app path calls. App-path modules deep-import
// (`@schema/theme.ts`), or the barrel drags `validators.generated.ts` into the eager bundle.

export * from "./aliases.generated.ts";
export * from "./camera.ts";
export * from "./colormap.ts";
export * from "./datasets.ts";
export * from "./layers.ts";
export * from "./log.ts";
export * from "./rayBox.ts";
export * from "./registry.ts";
export * from "./theme.ts";
export * from "./timing.ts";
export * from "./types.ts";
export * from "./validators.generated.ts";
export * from "./version.ts";
