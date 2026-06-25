import type { Vec3 } from "@schema/types.ts";
import type { ScalarFn } from "./analyticFieldCore.ts";

// Closed-form MHD configurations for the M3 compute-parity tests: Orszag–Tang, Harris, GEM. Each is a
// physically divergence-free magnetic field (∇·B = 0 by construction) with analytic curl and magnitude,
// so the numeric kernels validate against KNOWN physics — no external oracle, no pypic (DESIGN
// §Testing). Alias-free (only type-only imports, erased at runtime) so scripts/gen-synthetic.ts loads
// it under bare `node`, exactly like analyticFieldCore.ts.
//
// All three are z-invariant (2.5D on a 3D grid). Physical coord = index * spacing, origin 0, with
// spacing = domain / shape so a convergence test can halve h while holding the domain (and feature
// scale) fixed. Two regimes the consuming test relies on, given np.gradient differences each axis:
//   • Orszag–Tang & Harris — every component is constant along the axis it is differenced over, so the
//     FD divergence and the two zero curl components are EXACTLY zero (machine precision).
//   • GEM's island perturbation varies along the differencing axis → its FD divergence and curl_3 are
//     truncation-limited (the 2nd-order convergence target).
// Curl/divergence conventions mirror coordinates/operators.ts: div = ∂f1/∂x+∂f2/∂y+∂f3/∂z,
// curl = (∂f3/∂y−∂f2/∂z, ∂f1/∂z−∂f3/∂x, ∂f2/∂x−∂f1/∂y), axes 0/1/2 = x/y/z.

const TWO_PI = 2 * Math.PI;
const sech2 = (u: number): number => 1 / Math.cosh(u) ** 2;

// The five recipes both compute backends bind, matching crossBackend.ts CROSS_BACKEND_CASES.
export type SyntheticRecipe = "|B|" | "div_B" | "curl_B_1" | "curl_B_2" | "curl_B_3";

export interface SyntheticField {
  readonly name: string; // fixture filename stem
  readonly description: string;
  readonly domain: Vec3; // physical box size per axis; spacing = domain / shape
  readonly shape: readonly number[]; // checked-in fixture grid (small — the identities are exact at any n)
  readonly params: Readonly<Record<string, number>>; // provenance only
  readonly components: readonly [ScalarFn, ScalarFn, ScalarFn]; // B_1, B_2, B_3
  // Closed-form operator outputs. div_B is the exact 0 of a divergence-free field; |B| is the pointwise
  // magnitude (no differencing → matches the kernel to roundoff); curl is the analytic current density.
  readonly analytic: Readonly<Record<SyntheticRecipe, ScalarFn>>;
}

const ZERO: ScalarFn = () => 0;

function magnitudeOf(c: readonly [ScalarFn, ScalarFn, ScalarFn]): ScalarFn {
  return (x, y, z) => Math.hypot(c[0](x, y, z), c[1](x, y, z), c[2](x, y, z));
}

// Orszag–Tang vortex (z-invariant): the canonical periodic MHD test, B = (−sin y, sin 2x, 0) on
// [0,2π)². div = 0; curl = (0, 0, 2cos2x + cos y) — smooth, many zero-crossings.
function orszagTang(): SyntheticField {
  const components: SyntheticField["components"] = [
    (_x, y) => -Math.sin(y),
    (x) => Math.sin(2 * x),
    ZERO,
  ];
  return {
    name: "orszag-tang",
    description: "Orszag–Tang vortex B = (−sin y, sin 2x, 0), divergence-free (z-invariant)",
    domain: [TWO_PI, TWO_PI, 1],
    shape: [8, 12, 4],
    params: {},
    components,
    analytic: {
      "|B|": magnitudeOf(components),
      div_B: ZERO,
      curl_B_1: ZERO,
      curl_B_2: ZERO,
      curl_B_3: (x, y) => 2 * Math.cos(2 * x) + Math.cos(y),
    },
  };
}

// Harris current sheet with a guide field: B = (B0 tanh((y−yc)/L), 0, Bg). The classic reconnection
// equilibrium; the tanh kink is the f32-cancellation stressor. curl = (0, 0, −(B0/L) sech²((y−yc)/L)).
function harris(): SyntheticField {
  const B0 = 1;
  const L = 0.5;
  const Bg = 0.3;
  const Ly = 4;
  const yc = Ly / 2;
  const components: SyntheticField["components"] = [
    (_x, y) => B0 * Math.tanh((y - yc) / L),
    ZERO,
    () => Bg,
  ];
  return {
    name: "harris",
    description:
      "Harris current sheet B = (tanh((y−yc)/L), 0, Bg) with guide field, divergence-free",
    domain: [2, Ly, 1],
    shape: [8, 12, 4],
    params: { B0, L, Bg, yc },
    components,
    analytic: {
      "|B|": magnitudeOf(components),
      div_B: ZERO,
      curl_B_1: ZERO,
      curl_B_2: ZERO,
      curl_B_3: (_x, y) => -(B0 / L) * sech2((y - yc) / L),
    },
  };
}

// GEM reconnection: Harris sheet + a single magnetic island from flux ψ = ψ0 cos(kx x) cos(ky y),
// δB = ẑ × ∇ψ. Still ∇·B = 0 analytically, but the perturbation varies along the differencing axis,
// so the FD divergence and curl_3 are truncation-limited — the convergence target.
function gem(): SyntheticField {
  const B0 = 1;
  const L = 0.5;
  const psi0 = 0.1;
  const Lx = 4;
  const Ly = 4;
  const yc = Ly / 2;
  const kx = TWO_PI / Lx;
  const ky = Math.PI / Ly;
  const components: SyntheticField["components"] = [
    (x, y) => B0 * Math.tanh((y - yc) / L) - psi0 * ky * Math.cos(kx * x) * Math.sin(ky * y),
    (x, y) => psi0 * kx * Math.sin(kx * x) * Math.cos(ky * y),
    ZERO,
  ];
  return {
    name: "gem",
    description: "GEM challenge: Harris sheet + ψ=ψ0 cos(kx x)cos(ky y) island, divergence-free",
    domain: [Lx, Ly, 1],
    shape: [8, 12, 4],
    params: { B0, L, psi0, Lx, Ly, yc, kx, ky },
    components,
    analytic: {
      "|B|": magnitudeOf(components),
      div_B: ZERO,
      curl_B_1: ZERO,
      curl_B_2: ZERO,
      curl_B_3: (x, y) =>
        psi0 * (kx * kx + ky * ky) * Math.cos(kx * x) * Math.cos(ky * y) -
        (B0 / L) * sech2((y - yc) / L),
    },
  };
}

export const SYNTHETIC_FIELDS: readonly SyntheticField[] = [orszagTang(), harris(), gem()];

// spacing = domain / shape, so index*spacing spans [0, domain): refining `shape` holds the domain
// (and the feature scale) fixed, which is what the convergence test needs to halve h cleanly.
export function spacingFor(field: SyntheticField, shape: readonly number[]): Vec3 {
  return [
    field.domain[0] / (shape[0] ?? 1),
    field.domain[1] / (shape[1] ?? 1),
    field.domain[2] / (shape[2] ?? 1),
  ];
}
