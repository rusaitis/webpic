// WGSL/WESL compute kernels shared with the rustpic simulator (pypic-mirrored DAG layer). Standalone
// WGSL strings consumed through `compute/backends/webgpu`, not by three.js TSL. Each kernel module is
// imported directly by its one consumer, so this barrel re-exports nothing; it exists so the
// `@shaders` alias resolves (tests/aliases.test.ts).
export {};
