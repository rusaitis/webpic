// Packed `TraceMeta` layout (one per work-item), mirroring the WGSL `TraceMeta` struct: std430 array
// stride 16. The kernel sizes its readback buffer against this and compute/ decodes against it, so
// it is declared once rather than asserted equal by a test that reads the other file's source.
export const TRACE_META_BYTE_LENGTH = 16; // u32 nPoints, u32 reason, u32 nSteps, f32 maxLocalError
