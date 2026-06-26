// Numerical methods: the Dormand-Prince 5(4) adaptive ODE step + I-controller, the trilinear
// vector-field interpolator, and the adaptive field-line tracer built on them. Pure leaf — typed
// arrays in/out, no THREE/DOM/GPU. Mirrors pypic.numerics + pypic.traces; see docs/DESIGN.md.
export * from "./integrators.ts";
export * from "./interp.ts";
export * from "./tracing.ts";
