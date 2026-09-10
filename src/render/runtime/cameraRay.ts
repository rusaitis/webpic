import type { Vec3 } from "@schema/types.ts";
import { type Camera, Vector3 } from "three";

// The world-space ray under a screen point, unprojected through the live camera so it matches the
// rendered frame exactly — projection flip, aspect and pose included. The unit box has the identity
// transform, so world = object space for the pick march.
export function unprojectRay(
  camera: Camera,
  ndcX: number,
  ndcY: number,
): { readonly origin: Vec3; readonly dir: Vec3 } {
  camera.updateMatrixWorld(); // unproject outside a render needs fresh matrices
  const near = new Vector3(ndcX, ndcY, -1).unproject(camera);
  const far = new Vector3(ndcX, ndcY, 1).unproject(camera);
  const dir = far.sub(near).normalize();
  return { origin: [near.x, near.y, near.z], dir: [dir.x, dir.y, dir.z] };
}
