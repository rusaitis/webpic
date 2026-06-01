import type { FieldArray } from "@containers/field_dataset.ts";
import {
  currentDensityMagnitude,
  electricFieldMagnitude,
  magneticFieldMagnitude,
  velocityMagnitude,
} from "@derived/magnitude.ts";

type FloatArray = Float32Array | Float64Array;
type ComponentFn = (c1: FloatArray, c2: FloatArray, c3: FloatArray) => FloatArray;

// Wrap a (c1,c2,c3) derived fn into an op over input FieldArrays. Destructured rather than
// length-indexed: noUncheckedIndexedAccess won't narrow inputs[i] from a `.length` check.
function threeComponentOp(fn: ComponentFn): (inputs: readonly FieldArray[]) => FloatArray {
  return (inputs) => {
    const [c1, c2, c3] = inputs;
    if (c1 === undefined || c2 === undefined || c3 === undefined) {
      throw new Error(`magnitude op expects 3 components, got ${inputs.length}`);
    }
    return fn(c1.data, c2.data, c3.data);
  };
}

// Bind each pypic recipe `func` name to its derived implementation (mirrors pypic.compute
// RECIPES, where Recipe.func is the callable). |V_perp| etc. reuse velocity_magnitude.
export const MAGNITUDE_FIELD_OPS = {
  magnetic_field_magnitude: threeComponentOp(magneticFieldMagnitude),
  electric_field_magnitude: threeComponentOp(electricFieldMagnitude),
  current_density_magnitude: threeComponentOp(currentDensityMagnitude),
  velocity_magnitude: threeComponentOp(velocityMagnitude),
} satisfies Record<string, (inputs: readonly FieldArray[]) => FloatArray>;
