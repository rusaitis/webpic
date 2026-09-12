import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Scene } from "three";

export interface DebugTriangle {
  readonly scene: Scene;
  dispose(): void;
}

// A single gouraud-shaded triangle. Vertex colors interpolate to a gradient — a
// dense spread of distinct pixel values, which makes a 1-px parity diff a
// meaningful regression catch (a flat clear color would tie trivially). No
// lighting, no perspective: nothing here is renderer- or thread-dependent.
const POSITIONS = new Float32Array([0.0, 0.8, 0.0, -0.8, -0.6, 0.0, 0.8, -0.6, 0.0]);
const COLORS = new Float32Array([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);

export function createDebugTriangle(): DebugTriangle {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(POSITIONS, 3));
  geometry.setAttribute("color", new BufferAttribute(COLORS, 3));
  const material = new MeshBasicMaterial({ vertexColors: true });
  const mesh = new Mesh(geometry, material);

  // No scene.background — the renderer's clear color provides the background uniformly across
  // the boot frame and the composited layers.
  const scene = new Scene();
  scene.add(mesh);

  return {
    scene,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
