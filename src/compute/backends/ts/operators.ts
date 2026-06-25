import type { FieldArray } from "@containers/field_dataset.ts";
import { curl, divergence } from "@coordinates/operators.ts";
import type { Vec3 } from "@schema/types.ts";
import type { TsFieldOp } from "./index.ts";

// Differential field operators on the TS reference backend: curl + divergence, delegating to the one
// `coordinates/operators.ts` impl the WGSL kernel is also tested against (never a duplicate). The
// magnitude family ignores the grid; these read spacing + geometry off the op context (and curl its
// component index). The coordinates layer validates the grid (cartesian / 3-D / ≥2 samples / positive
// spacing) and throws the same way the WGSL backend's validateGridOp does.

function threeComponentInputs(
  inputs: readonly FieldArray[],
  op: string,
): [FieldArray, FieldArray, FieldArray] {
  const [c1, c2, c3] = inputs;
  if (c1 === undefined || c2 === undefined || c3 === undefined) {
    throw new Error(`ts backend: ${op} expects 3 component inputs, got ${inputs.length}`);
  }
  return [c1, c2, c3];
}

// GridInfo.spacing is a readonly number[]; the operators want a 3-tuple. A grid op only runs on a
// validated 3-D grid, so the three entries exist — `?? 0` makes a malformed grid throw in
// requirePositiveSpacing rather than read undefined.
function spacingVec3(spacing: readonly number[]): Vec3 {
  return [spacing[0] ?? 0, spacing[1] ?? 0, spacing[2] ?? 0];
}

const divergenceOp: TsFieldOp = (inputs, ctx) => {
  const [c1, c2, c3] = threeComponentInputs(inputs, "divergence");
  return divergence(c1.data, c2.data, c3.data, ctx.shape, spacingVec3(ctx.grid.spacing), {
    geometry: ctx.grid.geometry,
  });
};

// curl returns the full vector; the recipe's `component` selects one (curl_B_1 → 0, …). Computing all
// three to return one slice mirrors the reference exactly — the reference backend optimizes for
// verifiability, not for skipping the other two components (the WGSL kernel does select per dispatch).
const curlOp: TsFieldOp = (inputs, ctx) => {
  const [c1, c2, c3] = threeComponentInputs(inputs, "curl");
  const components = curl(c1.data, c2.data, c3.data, ctx.shape, spacingVec3(ctx.grid.spacing), {
    geometry: ctx.grid.geometry,
  });
  const index = ctx.component ?? 0;
  const out = components[index];
  if (out === undefined) {
    throw new Error(`ts backend: curl component ${index} out of range`);
  }
  return out;
};

// `div_b`/`div_e` share the field-agnostic divergence op (mirrors the WGSL backend's shared kernel).
export const OPERATOR_FIELD_OPS = {
  curl: curlOp,
  div_b: divergenceOp,
  div_e: divergenceOp,
} satisfies Record<string, TsFieldOp>;
