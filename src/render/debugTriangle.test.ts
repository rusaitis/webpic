import { Mesh, MeshBasicMaterial } from "three";
import { describe, expect, it, vi } from "vitest";
import type { DebugTriangle } from "./debugTriangle.ts";
import { createDebugTriangle } from "./debugTriangle.ts";

function meshOf(scene: DebugTriangle["scene"]): Mesh {
  const first = scene.children[0];
  if (!(first instanceof Mesh)) throw new Error("test scene has no mesh");
  return first;
}

function singleMaterial(mesh: Mesh): MeshBasicMaterial {
  const material = mesh.material;
  if (Array.isArray(material)) throw new Error("expected a single material");
  if (!(material instanceof MeshBasicMaterial)) throw new Error("expected MeshBasicMaterial");
  return material;
}

describe("createDebugTriangle", () => {
  it("builds an identical scene each call (the main/worker parity precondition)", () => {
    const a = createDebugTriangle();
    const b = createDebugTriangle();

    expect(a.scene.children).toHaveLength(1);
    expect(b.scene.children).toHaveLength(1);

    const ga = meshOf(a.scene).geometry;
    const gb = meshOf(b.scene).geometry;
    for (const attr of ["position", "color"] as const) {
      expect(Array.from(ga.getAttribute(attr).array)).toEqual(
        Array.from(gb.getAttribute(attr).array),
      );
    }

    // No per-scene background — the renderer's clear color now provides the background uniformly
    // (so composited layers don't each wipe the target). The parity precondition is the geometry.
    expect(a.scene.background).toBeNull();
    expect(b.scene.background).toBeNull();

    a.dispose();
    b.dispose();
  });

  it("enables vertex colors so the frame carries a non-trivial pixel spread", () => {
    const ts = createDebugTriangle();
    expect(singleMaterial(meshOf(ts.scene)).vertexColors).toBe(true);
    ts.dispose();
  });

  it("dispose() releases the geometry and material", () => {
    const ts = createDebugTriangle();
    const mesh = meshOf(ts.scene);
    const geometrySpy = vi.spyOn(mesh.geometry, "dispose");
    const materialSpy = vi.spyOn(singleMaterial(mesh), "dispose");
    ts.dispose();
    expect(geometrySpy).toHaveBeenCalledTimes(1);
    expect(materialSpy).toHaveBeenCalledTimes(1);
  });
});
