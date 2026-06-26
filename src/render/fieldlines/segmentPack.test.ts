import { describe, expect, it } from "vitest";
import { countSegments, packSegments } from "./segmentPack.ts";

describe("segmentPack", () => {
  it("expands a single polyline into consecutive segment pairs", () => {
    // 3 points → 2 segments: (p0,p1) and (p1,p2).
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    const counts = new Uint32Array([3]);
    expect(countSegments(counts)).toBe(2);
    expect(Array.from(packSegments(positions, counts))).toEqual([
      0, 0, 0, 1, 0, 0, /* seg 0 */ 1, 0, 0, 1, 1, 0 /* seg 1 */,
    ]);
  });

  it("partitions concatenated lines without bridging across boundaries", () => {
    // Line A: 3 pts (2 segs), line B: 2 pts (1 seg). The last vertex of A and the first of B must
    // never form a segment.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 2, 0, 0 /* A */, 9, 9, 9, 8, 8, 8 /* B */,
    ]);
    const counts = new Uint32Array([3, 2]);
    expect(countSegments(counts)).toBe(3);
    // The exhaustive equality pins every float, proving the forbidden bridge (2,0,0)->(9,9,9) is absent.
    expect(Array.from(packSegments(positions, counts))).toEqual([
      0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0 /* A: 2 segs */, 9, 9, 9, 8, 8, 8 /* B: 1 seg */,
    ]);
  });

  it("emits no segment for a line shorter than two vertices but still advances past it", () => {
    // counts [1, 2]: the lone point is skipped; the 2-point line still resolves to its own segment.
    const positions = new Float32Array([5, 5, 5 /* singleton */, 0, 0, 0, 1, 1, 1 /* pair */]);
    const counts = new Uint32Array([1, 2]);
    expect(countSegments(counts)).toBe(1);
    expect(Array.from(packSegments(positions, counts))).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it("returns empty for no lines", () => {
    expect(countSegments(new Uint32Array([]))).toBe(0);
    expect(packSegments(new Float32Array([]), new Uint32Array([])).length).toBe(0);
  });
});
