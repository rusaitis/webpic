import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
} from "three";
import { BACKGROUND_COLOR, FRUSTUM } from "./constants.ts";

export interface TestScene {
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  dispose(): void;
}

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
  scene.background = new Color(BACKGROUND_COLOR);
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
