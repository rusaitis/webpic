// Discrete vector identities the operators must preserve: div(curl F) = 0 and curl(grad f) = 0.
// These hold to *machine* precision (not just truncation precision) because np.gradient is a linear
// operator along a single axis, and per-axis linear operators commute — the mixed partials cancel
// pairwise at every grid point, edges included. Mirrors pypic tests/test_invariants. The gold tests.

import { describe, it } from "vitest";
import { assertAllclose, seededRandom } from "../../tests/helpers.ts";
import { curl, divergence, gradient } from "./operators.ts";

type Shape3 = readonly [number, number, number];
type Vec3 = readonly [number, number, number];

function sample(
  shape: Shape3,
  spacing: Vec3,
  fn: (x: number, y: number, z: number) => number,
): Float64Array {
  const [nx, ny, nz] = shape;
  const [dx, dy, dz] = spacing;
  const out = new Float64Array(nx * ny * nz);
  let p = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        out[p++] = fn(i * dx, j * dy, k * dz);
      }
    }
  }
  return out;
}

// Seeded pseudo-random field in [-1, 1] — the identity is point-wise, so a noisy field proves it
// holds for *any* input, not just smooth ones.
function pseudoRandomField(length: number, seed: number): Float64Array {
  const random = seededRandom(seed);
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = random() * 2 - 1;
  return out;
}

describe("div(curl F) = 0", () => {
  it("holds for a smooth field", () => {
    const shape: Shape3 = [16, 16, 16];
    const spacing: Vec3 = [0.1, 0.1, 0.1];
    const a1 = sample(shape, spacing, (_x, y) => Math.sin(y));
    const a2 = sample(shape, spacing, (_x, _y, z) => Math.sin(z));
    const a3 = sample(shape, spacing, (x) => Math.sin(x));
    const [c1, c2, c3] = curl(a1, a2, a3, shape, spacing);
    const result = divergence(c1, c2, c3, shape, spacing);
    assertAllclose(result, new Float64Array(result.length), { atol: 1e-10, rtol: 0 });
  });

  it("holds for an arbitrary (non-smooth) field to machine precision", () => {
    // Non-cube shape guards against axis-order bugs (confusing d1/d2/d3 or a stride).
    const shape: Shape3 = [5, 6, 7];
    const spacing: Vec3 = [0.1, 0.2, 0.3];
    const len = shape[0] * shape[1] * shape[2];
    const [c1, c2, c3] = curl(
      pseudoRandomField(len, 1),
      pseudoRandomField(len, 2),
      pseudoRandomField(len, 3),
      shape,
      spacing,
    );
    const result = divergence(c1, c2, c3, shape, spacing);
    // Roundoff scales with the worst inverse-spacing-squared in the second derivative (pypic's bound).
    const invDSqMax = 1 / Math.min(...spacing) ** 2;
    assertAllclose(result, new Float64Array(len), { atol: 2e-13 * invDSqMax, rtol: 0 });
  });
});

describe("curl(grad f) = 0", () => {
  it("holds for a smooth scalar field", () => {
    const shape: Shape3 = [16, 16, 16];
    const spacing: Vec3 = [0.1, 0.1, 0.1];
    const f = sample(shape, spacing, (x, y, z) => Math.sin(x) * Math.cos(y) * Math.exp(-0.1 * z));
    const [g1, g2, g3] = gradient(f, shape, spacing);
    const [c1, c2, c3] = curl(g1, g2, g3, shape, spacing);
    const z = new Float64Array(c1.length);
    assertAllclose(c1, z, { atol: 1e-10, rtol: 0 });
    assertAllclose(c2, z, { atol: 1e-10, rtol: 0 });
    assertAllclose(c3, z, { atol: 1e-10, rtol: 0 });
  });
});
