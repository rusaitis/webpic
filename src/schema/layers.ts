// Layer discriminants shared across the store → app → render seam. The DAG keeps store and render
// from importing each other, so the literal unions they must agree on live at the root instead of
// being restated on each side and re-narrowed on the wire.

/** The axis a slice holds fixed — world/field axis 0, 1, 2 (render/sliceScene maps it to THREE). */
export type SliceAxis = "x" | "y" | "z";

/** Layers that draw a 3D scalar texture (one upsert path: `upsertLayer`). */
export type FieldLayerKind = "slice" | "volume";

/** Layers that own traced polylines (`upsertFieldlines`) and trigger a retrace on change. */
export type TracingLayerKind = "fieldlines";

/** Every renderable layer kind, as the union of the two roles a kind can play — so a kind cannot
 *  join without claiming one. The composite camera and the store's layer union discriminate on it. */
export type LayerKind = FieldLayerKind | TracingLayerKind;
