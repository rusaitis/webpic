// WGSL compute kernels for the field operators magnitude / curl / divergence, shared with the
// rustpic simulator (standalone WGSL — a strict WESL subset; no preprocessor yet, so the shared
// prelude is concatenated as TS strings). One module, one bind-group layout, one `Params` struct,
// three entry points — so the byte layout has a single source and the runner binds the same 5
// resources for every op. All three take exactly 3 component inputs (magnitude: c1/c2/c3; curl &
// divergence: f1/f2/f3) so binding 0/1/2 = inputs, 3 = params, 4 = output.
//
// Indexing matches `coordinates/operators.ts`: row-major (nx,ny,nz), axes 0/1/2 = x/y/z, with
//   strideX = ny*nz, strideY = nz, strideZ = 1.
// Each invocation walks a grid-stride loop (`i += total_threads`) so a single X-dimension dispatch
// capped at the guaranteed 65535-workgroup limit still covers a 256³ field (16,777,216 > 65535*256).

import { PARAMS_STRUCT, STENCIL_PRELUDE } from "./prelude.wgsl.ts";

export const MAGNITUDE_ENTRY = "magnitude_main";
export const CURL_ENTRY = "curl_main";
export const DIVERGENCE_ENTRY = "divergence_main";

export const WORKGROUP_SIZE = 256;

const BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<storage, read> in0: array<f32>;
@group(0) @binding(1) var<storage, read> in1: array<f32>;
@group(0) @binding(2) var<storage, read> in2: array<f32>;
@group(0) @binding(3) var<storage, read> params: Params;
@group(0) @binding(4) var<storage, read_write> out: array<f32>;
`;

const ENTRY_POINTS = /* wgsl */ `
@compute @workgroup_size(${WORKGROUP_SIZE})
fn ${MAGNITUDE_ENTRY}(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>,
) {
  let total = nwg.x * ${WORKGROUP_SIZE}u;
  var i = gid.x;
  loop {
    if (i >= params.n) { break; }
    let x = in0[i];
    let y = in1[i];
    let z = in2[i];
    out[i] = sqrt(x * x + y * y + z * z);
    i = i + total;
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn ${DIVERGENCE_ENTRY}(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>,
) {
  let total = nwg.x * ${WORKGROUP_SIZE}u;
  let strideX = params.ny * params.nz;
  let strideY = params.nz;
  let strideZ = 1u;
  var i = gid.x;
  loop {
    if (i >= params.n) { break; }
    let sx = axisStencil(i, strideX, params.nx);
    let sy = axisStencil(i, strideY, params.ny);
    let sz = axisStencil(i, strideZ, params.nz);
    out[i] =
        diff1(in0[sx.lo], in0[i], in0[sx.hi], sx.atLow, sx.atHigh, params.invDx)
      + diff1(in1[sy.lo], in1[i], in1[sy.hi], sy.atLow, sy.atHigh, params.invDy)
      + diff1(in2[sz.lo], in2[i], in2[sz.hi], sz.atLow, sz.atHigh, params.invDz);
    i = i + total;
  }
}

// Curl: out = (∂f3/∂y − ∂f2/∂z, ∂f1/∂z − ∂f3/∂x, ∂f2/∂x − ∂f1/∂y)[component]. The component is a
// uniform per dispatch (all invocations read the same params.component), so the switch is divergence-
// free. Per-axis stencils are field-independent, computed once and reused across the two partials.
@compute @workgroup_size(${WORKGROUP_SIZE})
fn ${CURL_ENTRY}(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(num_workgroups) nwg: vec3<u32>,
) {
  let total = nwg.x * ${WORKGROUP_SIZE}u;
  let strideX = params.ny * params.nz;
  let strideY = params.nz;
  let strideZ = 1u;
  var i = gid.x;
  loop {
    if (i >= params.n) { break; }
    let sx = axisStencil(i, strideX, params.nx);
    let sy = axisStencil(i, strideY, params.ny);
    let sz = axisStencil(i, strideZ, params.nz);
    switch params.component {
      case 0u: {
        out[i] =
            diff1(in2[sy.lo], in2[i], in2[sy.hi], sy.atLow, sy.atHigh, params.invDy)
          - diff1(in1[sz.lo], in1[i], in1[sz.hi], sz.atLow, sz.atHigh, params.invDz);
      }
      case 1u: {
        out[i] =
            diff1(in0[sz.lo], in0[i], in0[sz.hi], sz.atLow, sz.atHigh, params.invDz)
          - diff1(in2[sx.lo], in2[i], in2[sx.hi], sx.atLow, sx.atHigh, params.invDx);
      }
      case 2u: {
        out[i] =
            diff1(in1[sx.lo], in1[i], in1[sx.hi], sx.atLow, sx.atHigh, params.invDx)
          - diff1(in0[sy.lo], in0[i], in0[sy.hi], sy.atLow, sy.atHigh, params.invDy);
      }
      default: { out[i] = 0.0; }
    }
    i = i + total;
  }
}
`;

export const FIELD_OPS_WGSL = `${PARAMS_STRUCT}\n${STENCIL_PRELUDE}\n${BINDINGS}\n${ENTRY_POINTS}`;
