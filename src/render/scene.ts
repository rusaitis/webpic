import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
} from "three";

export interface TestScene {
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  dispose(): void;
}

// Fixed clear color + camera frustum so worker and main-thread renders are
// bit-comparable. Values are arbitrary but must stay stable: the parity test
// diffs the resulting pixels.
const CLEAR_COLOR = 0x101820;
const FRUSTUM = { left: -1, right: 1, top: 1, bottom: -1, near: 0.1, far: 10 } as const;

// A single gouraud-shaded triangle. Vertex colors interpolate to a gradient — a
// dense spread of distinct pixel values, which makes a 1-px parity diff a
// meaningful regression catch (a flat clear color would tie trivially). No
// lighting, no perspective: nothing here is renderer- or thread-dependent.
const POSITIONS = new Float32Array([0.0, 0.8, 0.0, -0.8, -0.6, 0.0, 0.8, -0.6, 0.0]);
const COLORS = new Float32Array([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);

export function createTestScene(): TestScene {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(POSITIONS, 3));
  geometry.setAttribute("color", new BufferAttribute(COLORS, 3));
  const material = new MeshBasicMaterial({ vertexColors: true });
  const mesh = new Mesh(geometry, material);

  const scene = new Scene();
  scene.background = new Color(CLEAR_COLOR);
  scene.add(mesh);

  const camera = new OrthographicCamera(
    FRUSTUM.left,
    FRUSTUM.right,
    FRUSTUM.top,
    FRUSTUM.bottom,
    FRUSTUM.near,
    FRUSTUM.far,
  );
  camera.position.set(0, 0, 1);
  camera.lookAt(0, 0, 0);

  return {
    scene,
    camera,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
