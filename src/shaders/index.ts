// WGSL/WESL compute kernels shared with the rustpic simulator (pypic-mirrored DAG layer). Standalone
// WGSL strings — consumed by `gpu/computeKernel.ts` via the `compute/backends/webgpu` backend, not by
// three.js TSL. Field operators (magnitude/curl/divergence) and the streamline tracer live here;
// reduction kernels land with their milestone.
export {
  CURL_ENTRY,
  DIVERGENCE_ENTRY,
  FIELD_OPS_WGSL,
  MAGNITUDE_ENTRY,
  WORKGROUP_SIZE,
} from "./kernels/fieldOps.wgsl.ts";
export { PARAMS_STRUCT, STENCIL_PRELUDE } from "./kernels/prelude.wgsl.ts";
export {
  STREAMLINE_ENTRY,
  STREAMLINE_WGSL,
  STREAMLINE_WORKGROUP_SIZE,
} from "./kernels/streamline.wgsl.ts";
