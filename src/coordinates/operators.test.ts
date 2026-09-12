import { describe, expect, it } from "vitest";
import { assertAllclose } from "../../tests/helpers.ts";
import { TOL } from "../../tests/tolerances.ts";
import { curl, divergence, gradient } from "./operators.ts";

type Shape3 = readonly [number, number, number];
type Vec3 = readonly [number, number, number];

// Sample a scalar/component field over a row-major (nx, ny, nz) grid: axis 0 = x (slowest), axis 2
// = z (fastest), matching partialAlongAxis's stride convention and pypic's meshgrid(indexing="ij").
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

function constant(shape: Shape3, value: number): Float64Array {
  return new Float64Array(shape[0] * shape[1] * shape[2]).fill(value);
}

function zeros(length: number): Float64Array {
  return new Float64Array(length);
}

// Interior points only (1 ≤ coord ≤ n-2 on every axis) — where central differences are exact for
// quadratics; the one-sided edges are not.
function interior(arr: ArrayLike<number>, shape: Shape3): number[] {
  const [nx, ny, nz] = shape;
  const out: number[] = [];
  for (let i = 1; i < nx - 1; i++) {
    for (let j = 1; j < ny - 1; j++) {
      for (let k = 1; k < nz - 1; k++) {
        out.push(arr[(i * ny + j) * nz + k] ?? Number.NaN);
      }
    }
  }
  return out;
}

describe("divergence", () => {
  it("is zero for a uniform field", () => {
    const shape: Shape3 = [8, 8, 8];
    const result = divergence(
      constant(shape, 3),
      constant(shape, -1),
      constant(shape, 2),
      shape,
      [0.1, 0.1, 0.1],
    );
    assertAllclose(result, zeros(result.length), { atol: 1e-14, rtol: 0 });
  });

  it("is exact for the linear field F=(x,y,z) → div=3 (incl. edges)", () => {
    const shape: Shape3 = [8, 8, 8];
    const spacing: Vec3 = [1, 1, 1];
    const result = divergence(
      sample(shape, spacing, (x) => x),
      sample(shape, spacing, (_x, y) => y),
      sample(shape, spacing, (_x, _y, z) => z),
      shape,
      spacing,
    );
    assertAllclose(result, constant(shape, 3), TOL.divergence.ts_f64);
  });

  it("handles anisotropic spacing: F=(2x,3y,5z) → div=10", () => {
    const shape: Shape3 = [8, 8, 8];
    const spacing: Vec3 = [0.5, 0.3, 0.7];
    const result = divergence(
      sample(shape, spacing, (x) => 2 * x),
      sample(shape, spacing, (_x, y) => 3 * y),
      sample(shape, spacing, (_x, _y, z) => 5 * z),
      shape,
      spacing,
    );
    assertAllclose(result, constant(shape, 10), TOL.divergence.ts_f64);
  });

  it("propagates NaN", () => {
    const shape: Shape3 = [4, 4, 4];
    const f1 = constant(shape, 1);
    f1[(2 * 4 + 2) * 4 + 2] = Number.NaN;
    const result = divergence(f1, zeros(64), zeros(64), shape, [1, 1, 1]);
    expect(result.some((v) => Number.isNaN(v))).toBe(true);
  });
});

describe("curl", () => {
  it("is zero for a uniform field", () => {
    const shape: Shape3 = [8, 8, 8];
    const [c1, c2, c3] = curl(
      constant(shape, 5),
      constant(shape, -2),
      constant(shape, 7),
      shape,
      [0.1, 0.1, 0.1],
    );
    const z = zeros(c1.length);
    assertAllclose(c1, z, { atol: 1e-14, rtol: 0 });
    assertAllclose(c2, z, { atol: 1e-14, rtol: 0 });
    assertAllclose(c3, z, { atol: 1e-14, rtol: 0 });
  });

  it("is exact for rigid rotation F=(-y,x,0) → curl=(0,0,2)", () => {
    const shape: Shape3 = [8, 8, 8];
    const spacing: Vec3 = [0.5, 0.3, 0.7]; // anisotropic — guards d1/d2/d3 mix-ups
    const [c1, c2, c3] = curl(
      sample(shape, spacing, (_x, y) => -y),
      sample(shape, spacing, (x) => x),
      zeros(shape[0] * shape[1] * shape[2]),
      shape,
      spacing,
    );
    assertAllclose(c1, zeros(c1.length), { atol: 1e-12, rtol: 0 });
    assertAllclose(c2, zeros(c2.length), { atol: 1e-12, rtol: 0 });
    assertAllclose(c3, constant(shape, 2), TOL.curl.ts_f64);
  });
});

describe("gradient", () => {
  it("is exact for the linear field f=2x+3y+5z → (2,3,5)", () => {
    const shape: Shape3 = [8, 8, 8];
    const spacing: Vec3 = [0.5, 0.3, 0.7];
    const [g1, g2, g3] = gradient(
      sample(shape, spacing, (x, y, z) => 2 * x + 3 * y + 5 * z),
      shape,
      spacing,
    );
    assertAllclose(g1, constant(shape, 2), TOL.gradient.ts_f64);
    assertAllclose(g2, constant(shape, 3), TOL.gradient.ts_f64);
    assertAllclose(g3, constant(shape, 5), TOL.gradient.ts_f64);
  });

  it("is exact in the interior for the quadratic f=x²+y² → (2x,2y,0)", () => {
    const shape: Shape3 = [16, 16, 8];
    const spacing: Vec3 = [0.5, 0.5, 0.5];
    const [g1, g2, g3] = gradient(
      sample(shape, spacing, (x, y) => x * x + y * y),
      shape,
      spacing,
    );
    const expect1 = sample(shape, spacing, (x) => 2 * x);
    const expect2 = sample(shape, spacing, (_x, y) => 2 * y);
    assertAllclose(interior(g1, shape), interior(expect1, shape), TOL.gradient.ts_f64);
    assertAllclose(interior(g2, shape), interior(expect2, shape), TOL.gradient.ts_f64);
    assertAllclose(g3, zeros(g3.length), { atol: 1e-14, rtol: 0 });
  });
});

describe("operator guards", () => {
  const shape: Shape3 = [4, 4, 4];
  const f = zeros(64);

  it("rejects non-Cartesian geometry", () => {
    expect(() => curl(f, f, f, shape, [1, 1, 1], { geometry: "spherical" })).toThrow(/spherical/);
    expect(() => divergence(f, f, f, shape, [1, 1, 1], { geometry: "cylindrical" })).toThrow(
      /cylindrical/,
    );
    expect(() => gradient(f, shape, [1, 1, 1], { geometry: "spherical" })).toThrow(/spherical/);
  });

  it("rejects non-positive spacing", () => {
    expect(() => divergence(f, f, f, shape, [1, 0, 1])).toThrow(/spacing must be positive/);
  });

  it("rejects a non-3D grid", () => {
    expect(() => divergence(f, f, f, [64], [1, 1, 1])).toThrow(/3D grid/);
  });

  it("rejects a component-length mismatch", () => {
    expect(() => divergence(f, zeros(8), f, shape, [1, 1, 1])).toThrow(/grid volume/);
  });

  it("rejects a singleton axis, naming the axis (a pypic reduced dataset)", () => {
    const flat: Shape3 = [8, 8, 1];
    const g = zeros(64);
    expect(() => divergence(g, g, g, flat, [1, 1, 1])).toThrow(/axis 2 needs ≥2 samples/);
    expect(() => curl(g, g, g, flat, [1, 1, 1])).toThrow(/axis 2 needs ≥2 samples/);
    expect(() => gradient(g, flat, [1, 1, 1])).toThrow(/axis 2 needs ≥2 samples/);
  });
});
