import type { ColorScale } from "@schema/colormap.ts";
import type { WindowLevel } from "./normalization.ts";
import type { ScalarField } from "./volumeTexture.ts";

// What every field-layer scene needs to upload and color one scalar field. Slice and raymarch each
// extend it with the geometry their own material owns (a held plane; a march + box aspect), so the
// registry can build the shared half once — and a new field-layer kind starts from the same contract.

export interface FieldSceneOptions {
  readonly field: ScalarField;
  // Theme colormap name (`theme.colormaps.sequential`); unknown → inferno.
  readonly colormap: string;
  // Value→color window; absent → the field's full finite range (identity normalization).
  readonly windowLevel?: WindowLevel;
  // Value→color scale within the window; default linear.
  readonly scale?: ColorScale;
  // Per-layer opacity multiplier on the composited output, [0,1]; default 1 (opaque).
  readonly opacity?: number;
  // Device supports R32F linear sampling — picks the volume texture format.
  readonly hasFloat32Filterable?: boolean;
  // Layer id keying the volume texture into the VRAM ledger (perf HUD); omit to skip tracking.
  readonly ledgerKey?: string;
}
