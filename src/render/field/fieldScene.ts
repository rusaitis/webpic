import type { ColorScale } from "@schema/colormap.ts";
import { createNormalization, type Normalization, type WindowLevel } from "./normalization.ts";
import { createTransferFunctionTexture, type TransferFunctionTexture } from "./transferFunction.ts";
import { createVolumeTexture, type ScalarField, type VolumeTexture } from "./volumeTexture.ts";

// What every field-layer scene needs to upload and color one scalar field, and the constructor that
// builds it. Slice and raymarch each extend it with the geometry their own material owns (a held
// plane; a march + box aspect); a new field-layer kind starts from the same contract.

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

export interface FieldSceneBase {
  readonly volume: VolumeTexture;
  readonly tf: TransferFunctionTexture;
  readonly norm: Normalization;
}

// Upload the field, build its colormap texture, and map values into it. The default window spans the
// field's full finite range, so an absent windowLevel is the identity (v−min)/(max−min).
export function createFieldSceneBase(options: FieldSceneOptions): FieldSceneBase {
  const volume = createVolumeTexture(
    options.field,
    options.hasFloat32Filterable,
    options.ledgerKey,
  );
  return {
    volume,
    tf: createTransferFunctionTexture(options.colormap),
    norm: createNormalization(volume.min, volume.max, options.windowLevel, options.scale),
  };
}
