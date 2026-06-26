// Pack many polylines (flat xyz points + per-line vertex counts) into the interleaved segment-pair
// array `LineSegmentsGeometry.setPositions` expects: 6 floats per segment (start xyz, end xyz). A
// polyline of `count` vertices yields `count − 1` segments; a line shorter than 2 vertices yields none,
// so a degenerate trace can never bridge a segment into its neighbour. Pure — no THREE import — so the
// scene's geometry build is Node-testable (the twin of the WGSL/CPU tracers' own pure cores).

/** Total segments across all polylines: Σ max(countᵢ − 1, 0). */
export function countSegments(counts: Uint32Array): number {
  let segments = 0;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i] ?? 0;
    if (count >= 2) segments += count - 1;
  }
  return segments;
}

/** Expand concatenated polylines into `LineSegmentsGeometry` segment pairs. `positions` is flat
 *  row-major xyz for every vertex of every line in order; `counts[i]` is line i's vertex count (the
 *  lines partition `positions`). Returns a fresh `Float32Array` of `countSegments·6` floats. */
export function packSegments(positions: Float32Array, counts: Uint32Array): Float32Array {
  const out = new Float32Array(countSegments(counts) * 6);
  let read = 0; // vertex index into `positions` (xyz triples)
  let write = 0; // float index into `out`
  for (let line = 0; line < counts.length; line++) {
    const count = counts[line] ?? 0;
    for (let p = 0; p + 1 < count; p++) {
      const a = (read + p) * 3;
      const b = (read + p + 1) * 3;
      out[write] = positions[a] ?? 0;
      out[write + 1] = positions[a + 1] ?? 0;
      out[write + 2] = positions[a + 2] ?? 0;
      out[write + 3] = positions[b] ?? 0;
      out[write + 4] = positions[b + 1] ?? 0;
      out[write + 5] = positions[b + 2] ?? 0;
      write += 6;
    }
    read += count; // advance past this line's vertices even when it emitted no segment (count < 2)
  }
  return out;
}
