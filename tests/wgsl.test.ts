import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARAMS_BYTE_LENGTH } from "@compute/backends/webgpu/params.ts";
import {
  STREAMLINE_PARAMS_BYTE_LENGTH,
  TRACE_META_BYTE_LENGTH,
} from "@compute/backends/webgpu/streamlineParams.ts";
import {
  CURL_ENTRY,
  DIVERGENCE_ENTRY,
  FIELD_OPS_WGSL,
  MAGNITUDE_ENTRY,
  WORKGROUP_SIZE,
} from "@shaders/kernels/fieldOps.wgsl.ts";
import { PARAMS_STRUCT, STENCIL_PRELUDE } from "@shaders/kernels/prelude.wgsl.ts";
import {
  STREAMLINE_ENTRY,
  STREAMLINE_WGSL,
  STREAMLINE_WORKGROUP_SIZE,
} from "@shaders/kernels/streamline.wgsl.ts";
import { describe, expect, it } from "vitest";
import { WgslReflect } from "wgsl_reflect";

// The kernels are TS template strings, so a WGSL typo or a stale binding index survives typecheck
// and fails only on a real GPU (`test:gpu`, local-only, macOS-gated). Parsing the assembled sources
// here catches that in the node suite. It also pins the layouts `gpu/` duplicates by necessity: the
// gpu leaf imports nothing (DESIGN §Layered dependency DAG), so its binding arithmetic, workgroup
// size and struct byte lengths cannot reference @shaders and drift silently instead.
const ROOT = join(import.meta.dirname, "..");

function bindings(code: string): { name: string; binding: number; access: string }[] {
  return new WgslReflect(code).storage
    .map((resource) => ({
      name: resource.name,
      binding: resource.binding,
      access: resource.access ?? "read",
    }))
    .sort((a, b) => a.binding - b.binding);
}

function workgroupSize(code: string, entryPoint: string): number {
  const entry = new WgslReflect(code).entry.compute.find((fn) => fn.name === entryPoint);
  const size = entry?.attributes?.find((attribute) => attribute.name === "workgroup_size")?.value;
  return Number(size);
}

function structByteLength(code: string, name: string): number {
  const struct = new WgslReflect(code).structs.find((candidate) => candidate.name === name);
  return struct?.size ?? -1;
}

// The literal each runner dispatches against, read from source: `gpu/` cannot import @shaders.
function constInGpuSource(file: string, name: string): number {
  const source = readFileSync(join(ROOT, "src", "gpu", file), "utf8");
  const match = source.match(new RegExp(`const ${name} = (\\d+)`));
  return Number(match?.[1]);
}

describe("prelude.wgsl", () => {
  it("parses as a standalone module", () => {
    const reflect = new WgslReflect(`${PARAMS_STRUCT}\n${STENCIL_PRELUDE}`);
    expect(reflect.structs.map((s) => s.name)).toContain("Params");
    expect(reflect.functions.map((f) => f.name)).toContain("axisStencil");
  });

  it("packs Params exactly as the CPU-side DataView does", () => {
    expect(structByteLength(PARAMS_STRUCT, "Params")).toBe(PARAMS_BYTE_LENGTH);
  });
});

describe("fieldOps.wgsl", () => {
  it("declares every entry point the backend dispatches", () => {
    const compute = new WgslReflect(FIELD_OPS_WGSL).entry.compute.map((fn) => fn.name);
    expect(new Set(compute)).toEqual(new Set([MAGNITUDE_ENTRY, CURL_ENTRY, DIVERGENCE_ENTRY]));
  });

  it("binds three read-only inputs, then params, then the single output", () => {
    // runFieldKernel puts params at `inputs.length` and the output at `inputs.length + 1`.
    expect(bindings(FIELD_OPS_WGSL)).toEqual([
      { name: "in0", binding: 0, access: "read" },
      { name: "in1", binding: 1, access: "read" },
      { name: "in2", binding: 2, access: "read" },
      { name: "params", binding: 3, access: "read" },
      { name: "out", binding: 4, access: "read_write" },
    ]);
  });

  it("declares the workgroup size computeKernel divides the dispatch by", () => {
    for (const entry of [MAGNITUDE_ENTRY, CURL_ENTRY, DIVERGENCE_ENTRY]) {
      expect(workgroupSize(FIELD_OPS_WGSL, entry)).toBe(WORKGROUP_SIZE);
    }
    expect(constInGpuSource("computeKernel.ts", "WORKGROUP_SIZE")).toBe(WORKGROUP_SIZE);
  });
});

describe("streamline.wgsl", () => {
  it("declares the entry point the backend dispatches", () => {
    const compute = new WgslReflect(STREAMLINE_WGSL).entry.compute.map((fn) => fn.name);
    expect(compute).toEqual([STREAMLINE_ENTRY]);
  });

  it("binds the fixed seven-slot streamline layout", () => {
    expect(bindings(STREAMLINE_WGSL)).toEqual([
      { name: "b1", binding: 0, access: "read" },
      { name: "b2", binding: 1, access: "read" },
      { name: "b3", binding: 2, access: "read" },
      { name: "params", binding: 3, access: "read" },
      { name: "seeds", binding: 4, access: "read" },
      { name: "outPoints", binding: 5, access: "read_write" },
      { name: "outMeta", binding: 6, access: "read_write" },
    ]);
  });

  it("declares the workgroup size streamlineKernel divides the dispatch by", () => {
    expect(workgroupSize(STREAMLINE_WGSL, STREAMLINE_ENTRY)).toBe(STREAMLINE_WORKGROUP_SIZE);
    expect(constInGpuSource("streamlineKernel.ts", "WORKGROUP_SIZE")).toBe(
      STREAMLINE_WORKGROUP_SIZE,
    );
  });

  it("packs Params and TraceMeta exactly as the CPU-side DataViews do", () => {
    expect(structByteLength(STREAMLINE_WGSL, "Params")).toBe(STREAMLINE_PARAMS_BYTE_LENGTH);
    expect(structByteLength(STREAMLINE_WGSL, "TraceMeta")).toBe(TRACE_META_BYTE_LENGTH);
  });
});
