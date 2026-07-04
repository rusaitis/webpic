// WGSL streamline compute kernel — the GPU twin of the CPU field-line tracer (numerics/tracing.ts +
// integrators.ts + interp.ts). One invocation per (seed, direction) work-item integrates dr/ds = ±B̂(r)
// with adaptive Dormand-Prince 5(4) and the elementary **I** step controller, arc-length parameterized.
// Standalone WGSL (a strict WESL subset, no preprocessor) — shared forward with rustpic, consumed by
// `gpu/streamlineKernel.ts`, not three.js TSL. Every routine below is a line-for-line transliteration of
// the f64 reference so GPU≡CPU≡pypic golden parity holds at f32 tolerance:
//   sampleField ← interp.ts `sample`/`blend`   (cell-centered −0.5 index map, row-major (i*ny+j)*nz+k)
//   rhs         ← tracing.ts `makeRhs`          (unit field direction, sign-bearing; null on exit/null)
//   dpStep      ← integrators.ts `dormandPrinceStep` (7-stage FSAL, exact tableau fractions)
//   errorNorm   ← integrators.ts `embeddedErrorNorm`
//   iController ← integrators.ts `iStepController`  (PI is *not* implemented — pypic ships I; DESIGN §Field lines)
//   streamline_main ← tracing.ts `traceSingleDirectionAdaptive`
//
// Field B is bound as three storage buffers (not a 3D texture): manual trilinear reproduces the f64
// `blend()` operation order exactly, so the only gap is f32 roundoff — hardware `textureSampleLevel` has
// implementation-defined sub-texel rounding that would risk the trace tolerance. The "both"/backward
// stitch + FieldLine assembly stay on the CPU (the orchestrator reuses tracing.ts `stitch`).

export const STREAMLINE_ENTRY = "streamline_main";
export const STREAMLINE_WORKGROUP_SIZE = 64;

// Scalars-only std430 struct (4-byte tight packing) — mirrored byte-for-byte by
// `compute/backends/webgpu/streamlineParams.ts`. Keep the two in lockstep; never add a vec/array member
// here without mirroring the offset on the CPU side. Carries the grid **origin** (the cell-centered map
// needs absolute coordinates — the first kernel that does; the field-op kernels needed only invD*).
const STRUCTS = /* wgsl */ `
struct Params {
  nx: u32,            ny: u32,            nz: u32,
  ox: f32,            oy: f32,            oz: f32,
  invDx: f32,         invDy: f32,         invDz: f32,
  atol: f32,          rtol: f32,
  stepInit: f32,      minStep: f32,       maxStep: f32,
  nullThreshold: f32,
  loopTol: f32,       loopMinArclen: f32, loopEnabled: u32,
  maxSteps: u32,      capacity: u32,      nWork: u32,
};

// Per-work-item result. reason is a numerics/tracing.ts REASON_CODES integer (0 max_steps, 1 domain_exit,
// 2 null_point, 4 closed_loop; 3 callback is CPU-only and never emitted here). maxLocalError is the peak
// embedded error norm across all attempted steps (accepted and rejected).
struct TraceMeta {
  nPoints: u32,
  reason: u32,
  nSteps: u32,
  maxLocalError: f32,
};
`;

// Dormand-Prince 5(4) Butcher tableau as abstract-float consts (const-evaluated at high precision, then
// rounded to f32 at use) — the closest f32 can sit to the f64 reference's exact fractions. E = B5 − B4.
const TABLEAU = /* wgsl */ `
const A21 = 1.0 / 5.0;
const A31 = 3.0 / 40.0;        const A32 = 9.0 / 40.0;
const A41 = 44.0 / 45.0;       const A42 = -56.0 / 15.0;      const A43 = 32.0 / 9.0;
const A51 = 19372.0 / 6561.0;  const A52 = -25360.0 / 2187.0; const A53 = 64448.0 / 6561.0;  const A54 = -212.0 / 729.0;
const A61 = 9017.0 / 3168.0;   const A62 = -355.0 / 33.0;     const A63 = 46732.0 / 5247.0;  const A64 = 49.0 / 176.0;   const A65 = -5103.0 / 18656.0;
const A71 = 35.0 / 384.0;      const A73 = 500.0 / 1113.0;    const A74 = 125.0 / 192.0;     const A75 = -2187.0 / 6784.0; const A76 = 11.0 / 84.0;
const B51 = 35.0 / 384.0;      const B53 = 500.0 / 1113.0;    const B54 = 125.0 / 192.0;     const B55 = -2187.0 / 6784.0; const B56 = 11.0 / 84.0;
const E1 = 35.0 / 384.0 - 5179.0 / 57600.0;
const E3 = 500.0 / 1113.0 - 7571.0 / 16695.0;
const E4 = 125.0 / 192.0 - 393.0 / 640.0;
const E5 = -2187.0 / 6784.0 - (-92097.0 / 339200.0);
const E6 = 11.0 / 84.0 - 187.0 / 2100.0;
const E7 = -1.0 / 40.0;
const SAFETY = 0.9;
const GROWTH_MIN = 0.2;
const GROWTH_MAX = 5.0;
const ERR_FLOOR = 1e-15;
`;

const BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<storage, read> b1: array<f32>;
@group(0) @binding(1) var<storage, read> b2: array<f32>;
@group(0) @binding(2) var<storage, read> b3: array<f32>;
@group(0) @binding(3) var<storage, read> params: Params;
@group(0) @binding(4) var<storage, read> seeds: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> outPoints: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> outMeta: array<TraceMeta>;
`;

// Storage-array pointers can't be function parameters in core WGSL, so the 8 corner values are read at the
// call site (same indices for all three components) and passed by value to this pure lerp.
const HELPERS = /* wgsl */ `
fn blend8(
  c000: f32, c100: f32, c010: f32, c110: f32,
  c001: f32, c101: f32, c011: f32, c111: f32,
  fx: f32, fy: f32, fz: f32,
) -> f32 {
  let c00 = c000 + fx * (c100 - c000);
  let c10 = c010 + fx * (c110 - c010);
  let c01 = c001 + fx * (c101 - c001);
  let c11 = c011 + fx * (c111 - c011);
  let c0 = c00 + fy * (c10 - c00);
  let c1v = c01 + fy * (c11 - c01);
  return c0 + fz * (c1v - c0);
}

fn sampleField(p: vec3<f32>, out: ptr<function, vec3<f32>>) -> bool {
  let nx = params.nx;
  let ny = params.ny;
  let nz = params.nz;
  let tx = (p.x - params.ox) * params.invDx - 0.5;
  let ty = (p.y - params.oy) * params.invDy - 0.5;
  let tz = (p.z - params.oz) * params.invDz - 0.5;
  // The >= && <= form rejects NaN too (a NaN coordinate fails the chain → out of domain).
  if (!(tx >= 0.0 && tx <= f32(nx - 1u) && ty >= 0.0 && ty <= f32(ny - 1u) && tz >= 0.0 && tz <= f32(nz - 1u))) {
    return false;
  }
  var i0 = u32(floor(tx));
  var j0 = u32(floor(ty));
  var k0 = u32(floor(tz));
  if (i0 > nx - 2u) { i0 = nx - 2u; }
  if (j0 > ny - 2u) { j0 = ny - 2u; }
  if (k0 > nz - 2u) { k0 = nz - 2u; }
  let sx = ny * nz;
  let sy = nz;
  let base = (i0 * ny + j0) * nz + k0;
  let fx = tx - f32(i0);
  let fy = ty - f32(j0);
  let fz = tz - f32(k0);
  let i000 = base;
  let i100 = base + sx;
  let i010 = base + sy;
  let i110 = base + sx + sy;
  let i001 = base + 1u;
  let i101 = base + sx + 1u;
  let i011 = base + sy + 1u;
  let i111 = base + sx + sy + 1u;
  (*out).x = blend8(b1[i000], b1[i100], b1[i010], b1[i110], b1[i001], b1[i101], b1[i011], b1[i111], fx, fy, fz);
  (*out).y = blend8(b2[i000], b2[i100], b2[i010], b2[i110], b2[i001], b2[i101], b2[i011], b2[i111], fx, fy, fz);
  (*out).z = blend8(b3[i000], b3[i100], b3[i010], b3[i110], b3[i001], b3[i101], b3[i011], b3[i111], fx, fy, fz);
  return true;
}

// dr/ds = sign · B / |B|, or false on a domain exit (sampleField false) / field null (|B| < threshold).
fn rhs(p: vec3<f32>, sign: f32, dir: ptr<function, vec3<f32>>) -> bool {
  var field: vec3<f32>;
  if (!sampleField(p, &field)) { return false; }
  let mag = length(field);
  if (mag < params.nullThreshold) { return false; }
  *dir = field * (sign / mag);
  return true;
}

fn errorNorm(errVec: vec3<f32>, yNew: vec3<f32>, atol: f32, rtol: f32) -> f32 {
  let scale = vec3<f32>(atol) + rtol * abs(yNew);
  let scaled = errVec / scale;
  return sqrt(dot(scaled, scaled) / 3.0);
}

fn iController(h: f32, errNorm: f32, minStep: f32, maxStep: f32) -> f32 {
  let raw = SAFETY * pow(max(errNorm, ERR_FLOOR), -1.0 / 5.0);
  let factor = min(GROWTH_MAX, max(GROWTH_MIN, raw));
  return min(maxStep, max(minStep, h * factor));
}

// One DP5(4) FSAL step. Returns false and writes the failed stage's input to *failedPoint on a null RHS;
// otherwise writes the 5th-order solution, embedded error, and FSAL carry (stage-7 RHS = f(yNew)). Pass
// hasK0 to reuse the previous accepted step's kCarry as stage 1 (FSAL).
fn dpStep(
  y: vec3<f32>, h: f32, sign: f32, k0: vec3<f32>, hasK0: bool,
  yNew: ptr<function, vec3<f32>>, errVec: ptr<function, vec3<f32>>,
  kLast: ptr<function, vec3<f32>>, failedPoint: ptr<function, vec3<f32>>,
) -> bool {
  var k1: vec3<f32>;
  if (hasK0) {
    k1 = k0;
  } else if (!rhs(y, sign, &k1)) {
    *failedPoint = y;
    return false;
  }
  var k2: vec3<f32>;
  let y2 = y + h * (A21 * k1);
  if (!rhs(y2, sign, &k2)) { *failedPoint = y2; return false; }
  var k3: vec3<f32>;
  let y3 = y + h * (A31 * k1 + A32 * k2);
  if (!rhs(y3, sign, &k3)) { *failedPoint = y3; return false; }
  var k4: vec3<f32>;
  let y4 = y + h * (A41 * k1 + A42 * k2 + A43 * k3);
  if (!rhs(y4, sign, &k4)) { *failedPoint = y4; return false; }
  var k5: vec3<f32>;
  let y5 = y + h * (A51 * k1 + A52 * k2 + A53 * k3 + A54 * k4);
  if (!rhs(y5, sign, &k5)) { *failedPoint = y5; return false; }
  var k6: vec3<f32>;
  let y6 = y + h * (A61 * k1 + A62 * k2 + A63 * k3 + A64 * k4 + A65 * k5);
  if (!rhs(y6, sign, &k6)) { *failedPoint = y6; return false; }
  var k7: vec3<f32>;
  // Stage-7 weights equal B5, so y7 == yNew → k7 = f(yNew), the FSAL carry.
  let y7 = y + h * (A71 * k1 + A73 * k3 + A74 * k4 + A75 * k5 + A76 * k6);
  if (!rhs(y7, sign, &k7)) { *failedPoint = y7; return false; }
  *yNew = y + h * (B51 * k1 + B53 * k3 + B54 * k4 + B55 * k5 + B56 * k6);
  *errVec = h * (E1 * k1 + E3 * k3 + E4 * k4 + E5 * k5 + E6 * k6 + E7 * k7);
  *kLast = k7;
  return true;
}
`;

const ENTRY = /* wgsl */ `
@compute @workgroup_size(${STREAMLINE_WORKGROUP_SIZE})
fn ${STREAMLINE_ENTRY}(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = gid.x;
  if (w >= params.nWork) { return; }
  let seed4 = seeds[w];
  let sign = seed4.w;
  let base = w * params.capacity;

  var p = seed4.xyz;
  outPoints[base] = vec4<f32>(p, 0.0);   // point 0 = seed, arclength 0
  var n: u32 = 0u;
  var reason: u32 = 0u;                   // max_steps until a stop fires
  var h = params.stepInit;
  var maxLocalError: f32 = 0.0;
  var kCarry = vec3<f32>(0.0);
  var hasCarry = false;

  loop {
    if (n >= params.maxSteps) { break; }
    var yNew: vec3<f32>;
    var errVec: vec3<f32>;
    var kLast: vec3<f32>;
    var failedPoint: vec3<f32>;
    if (!dpStep(p, h, sign, kCarry, hasCarry, &yNew, &errVec, &kLast, &failedPoint)) {
      var probe: vec3<f32>;
      reason = select(1u, 2u, sampleField(failedPoint, &probe)); // in-domain → null_point, else domain_exit
      break;
    }

    let en = errorNorm(errVec, yNew, params.atol, params.rtol);
    maxLocalError = max(maxLocalError, en);
    let hNew = iController(h, en, params.minStep, params.maxStep);

    if (en <= 1.0 || h <= params.minStep) {
      n = n + 1u;
      let segLen = distance(yNew, p);
      let arclen = outPoints[base + n - 1u].w + segLen;
      outPoints[base + n] = vec4<f32>(yNew, arclen);
      p = yNew;
      kCarry = kLast;
      hasCarry = true;
      h = hNew;

      if (params.loopEnabled == 1u) {
        let cutoff = arclen - params.loopMinArclen;
        // searchSortedRight over the monotone arclen prefix [0, n): first j with arclen[j] > cutoff.
        var jEnd: u32 = 0u;
        loop {
          if (jEnd >= n || outPoints[base + jEnd].w > cutoff) { break; }
          jEnd = jEnd + 1u;
        }
        if (jEnd > 0u) {
          var minDist = 3.4e38;
          var j: u32 = 0u;
          loop {
            if (j >= jEnd) { break; }
            minDist = min(minDist, distance(outPoints[base + j].xyz, yNew));
            j = j + 1u;
          }
          if (minDist <= params.loopTol) {
            reason = 4u;   // closed_loop
            break;
          }
        }
      }
    } else {
      h = hNew;   // reject: retry with smaller h, p and kCarry unchanged
    }
  }

  outMeta[w] = TraceMeta(n + 1u, reason, n, maxLocalError);
}
`;

export const STREAMLINE_WGSL = `${STRUCTS}\n${TABLEAU}\n${BINDINGS}\n${HELPERS}\n${ENTRY}`;
