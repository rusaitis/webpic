// Numerical methods: the Dormand-Prince 5(4) adaptive ODE step + I-controller the CPU field-line
// tracer is built on (interpolation + tracing land alongside). Pure leaf — typed arrays in/out, no
// THREE/DOM/GPU. Mirrors pypic.numerics; see docs/DESIGN.md.
export * from "./integrators.ts";
