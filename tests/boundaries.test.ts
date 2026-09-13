import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import {
  createSourceProject,
  findViolations,
  gatherEdges,
  layerOfPath,
  specifierToLayer,
} from "../scripts/check-boundaries.ts";
import { canImport } from "../scripts/layers.ts";

describe("layer DAG (canImport)", () => {
  it("permits allowed edges and same-layer imports", () => {
    expect(canImport("containers", "schema")).toBe(true);
    expect(canImport("ui", "store")).toBe(true);
    expect(canImport("workers", "compute")).toBe(true);
    expect(canImport("app", "render")).toBe(true);
    expect(canImport("coordinates", "coordinates")).toBe(true);
  });

  it("rejects edges outside the allowed set", () => {
    expect(canImport("schema", "containers")).toBe(false);
    expect(canImport("ui", "render")).toBe(false);
    expect(canImport("embed", "render")).toBe(false);
    expect(canImport("workers", "ui")).toBe(false);
  });
});

describe("specifier/path → layer mapping", () => {
  const fromFile = "/repo/src/derived/foo.ts";

  it("maps alias specifiers to their layer", () => {
    expect(specifierToLayer("@render/passes/x", fromFile)).toBe("render");
    expect(specifierToLayer("@schema", fromFile)).toBe("schema");
    expect(specifierToLayer("@notalayer", fromFile)).toBeUndefined();
  });

  it("resolves relative specifiers against the importing file", () => {
    expect(specifierToLayer("../coordinates/curl", fromFile)).toBe("coordinates");
    expect(specifierToLayer("./local", fromFile)).toBe("derived");
  });

  it("treats bare and node: specifiers as external", () => {
    expect(specifierToLayer("three", fromFile)).toBeUndefined();
    expect(specifierToLayer("node:path", fromFile)).toBeUndefined();
  });

  it("maps file paths to layers (POSIX + Windows, dir-root + nested)", () => {
    expect(layerOfPath("/a/src/ui/widget.ts")).toBe("ui");
    expect(layerOfPath("/a/src/coordinates")).toBe("coordinates");
    expect(layerOfPath("C:\\a\\src\\gpu\\device.ts")).toBe("gpu");
    expect(layerOfPath("/a/src/main.ts")).toBeUndefined();
    expect(layerOfPath("/a/scripts/foo.ts")).toBeUndefined();
  });
});

describe("gatherEdges + findViolations (in-memory project)", () => {
  it("flags type-only, dynamic, and re-export escapes but not legal imports", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "/src/ui/widget.ts",
      'import type { A } from "@render";\nexport type W = A;\n',
    );
    project.createSourceFile("/src/store/s.ts", 'export const p = import("@ui");\n');
    project.createSourceFile("/src/data/d.ts", 'export { x } from "@render";\n');
    project.createSourceFile("/src/workers/data.worker.ts", 'import "@ui/panel";\n');
    project.createSourceFile(
      "/src/coordinates/c.ts",
      'import { y } from "@containers";\nexport const z = y;\n',
    );

    const edges = gatherEdges(project);
    const violations = findViolations(edges);
    const signatures = new Set(violations.map((v) => `${v.fromLayer}->${v.toLayer}`));

    expect(signatures).toEqual(new Set(["ui->render", "store->ui", "data->render", "workers->ui"]));
    // the legal edge is gathered but not a violation
    expect(edges.some((e) => e.fromLayer === "coordinates" && e.toLayer === "containers")).toBe(
      true,
    );
    expect(signatures.has("coordinates->containers")).toBe(false);
  });
});

describe("real source tree", () => {
  // The ts-morph whole-project load scales with the tree and runs beside the rest of the suite —
  // it drifts past the 5 s vitest default under parallel load without being unhealthy. Parsed once
  // for the whole block: the edge set is the same input both assertions read.
  const edges = gatherEdges(createSourceProject());

  it("has no layer-boundary violations", { timeout: 60_000 }, () => {
    expect(findViolations(edges)).toEqual([]);
  });

  it("sees the worker sources tsconfig.json excludes", { timeout: 60_000 }, () => {
    expect(edges.some((e) => e.fromLayer === "workers")).toBe(true);
  });
});
