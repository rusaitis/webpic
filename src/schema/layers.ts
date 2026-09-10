// Layer discriminants shared across the store → app → render seam. The DAG keeps store and render
// from importing each other, so the literal unions they must agree on live at the root instead of
// being restated on each side and re-narrowed on the wire.

/** The axis a slice holds fixed — world/field axis 0, 1, 2 (render/sliceScene maps it to THREE). */
export type SliceAxis = "x" | "y" | "z";

/** Layers that draw a 3D scalar texture (one upsert path: `upsertLayer`). */
export type FieldLayerKind = "slice" | "volume";

/** Every renderable layer kind: field layers plus packed-polyline field lines (`upsertFieldlines`).
 *  The composite camera and the store's layer union both discriminate on it. */
export type LayerKind = FieldLayerKind | "fieldlines";
