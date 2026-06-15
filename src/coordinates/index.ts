// Coordinate transforms + the TS reference impls of the differential operators (curl/divergence/
// gradient) the compute backends are tested against. Pure leaf — typed arrays in/out, no THREE/DOM/GPU.
// Mirrors pypic.coordinates; see docs/DESIGN.md.
export * from "./operators.ts";
