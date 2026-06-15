// Analytic colormaps: the source of truth for the GPU transfer-function LUT
// (transferFunction.ts samples `colormapColor` into a 256×1 texture). Each is a degree-6
// polynomial fit to the matplotlib sequentials (https://www.shadertoy.com/view/WlfXRN), evaluated
// in Horner form. Unknown names fall back to inferno.

import type { ColormapId } from "@schema/colormap.ts";

export type Rgb = readonly [number, number, number];
// The id union is owned by @schema (the authority); typing COLORMAP_COEFFS by it makes TS enforce
// that schema's COLORMAP_IDS and render's polynomial fits stay in lockstep.
export type ColormapName = ColormapId;

// c0..c6 — the polynomial coefficients, one Rgb per power of t.
type Coeffs = readonly [Rgb, Rgb, Rgb, Rgb, Rgb, Rgb, Rgb];

const VIRIDIS: Coeffs = [
  [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
  [0.1050930431085774, 1.404613529898575, 1.384590162594685],
  [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
  [-4.634230498983486, -5.799100973351585, -19.33244095627987],
  [6.228269936347081, 14.17993336680509, 56.69055260068105],
  [4.776384997670288, -13.74514537774601, -65.35303263337234],
  [-5.435455855934631, 4.645852612178535, 26.3124352495832],
];

const INFERNO: Coeffs = [
  [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
  [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
  [11.60249308247187, -3.972853965665698, -15.9423941062914],
  [-41.70399613139459, 17.43639888205313, 44.35414519872813],
  [77.162935699427, -33.40235894210092, -81.80730925738993],
  [-71.31942824499214, 32.62606426397723, 73.20951985803202],
  [25.13112622477341, -12.24266895238567, -23.07032500287172],
];

const PLASMA: Coeffs = [
  [0.05873234392399702, 0.02333670892565664, 0.5433401826748754],
  [2.176514634195958, 0.2383834171260182, 0.7539604599784036],
  [-2.689460476458034, -7.455851135738909, 3.110799939717086],
  [6.130348345893603, 42.3461881477227, -28.51885465332158],
  [-11.10743619062271, -82.66631109428045, 60.13984767418263],
  [10.02306557647065, 71.41361770095349, -54.07218655560067],
  [-3.658713842777788, -22.93153465461149, 18.19190778539828],
];

const MAGMA: Coeffs = [
  [-0.002136485053939582, -0.000749655052795221, -0.005386127855323933],
  [0.2516605407371642, 0.6775232436837668, 2.494026599312351],
  [8.353717279216625, -3.577719514958484, 0.3144679030132573],
  [-27.66873308576866, 14.26473078096533, -13.64921318813922],
  [52.17613981234068, -27.94360607168351, 12.94416944238394],
  [-50.76852536473588, 29.04658282127291, 4.23415299384598],
  [18.65570506591883, -11.48977351997711, -5.601961508734096],
];

export const COLORMAP_COEFFS: Readonly<Record<ColormapId, Coeffs>> = {
  inferno: INFERNO,
  viridis: VIRIDIS,
  plasma: PLASMA,
  magma: MAGMA,
};

/** Map any colormap name (matplotlib labels, theme `sequential`) to a supported fit;
 *  unsupported names (diverging maps, cividis, …) fall back to inferno. */
export function resolveColormapName(name: string): ColormapName {
  // hasOwn guards the cast: the four keys above are the only own properties.
  return Object.hasOwn(COLORMAP_COEFFS, name) ? (name as ColormapName) : "inferno";
}

function channel(c: Coeffs, k: 0 | 1 | 2, t: number): number {
  let v = c[6][k];
  v = v * t + c[5][k];
  v = v * t + c[4][k];
  v = v * t + c[3][k];
  v = v * t + c[2][k];
  v = v * t + c[1][k];
  v = v * t + c[0][k];
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Sample a colormap at `t`; `t` is clamped to [0,1] and each channel saturated to [0,1].
 *  The source the transfer-function LUT is baked from and the Node tests check against. */
export function colormapColor(name: string, t: number): Rgb {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  const c = COLORMAP_COEFFS[resolveColormapName(name)];
  return [channel(c, 0, u), channel(c, 1, u), channel(c, 2, u)];
}
