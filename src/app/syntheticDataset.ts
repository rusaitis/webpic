import type {
  FieldArray,
  FieldDataset,
  GridInfo,
  Normalization,
  PhysicsParams,
} from "@containers/field_dataset.ts";
import { fieldInfo } from "@schema/registry.ts";
import type { FieldName } from "@schema/types.ts";

// Scaffold: a deterministic in-memory B field so the app renders a real |B| slice with no
// data source wired (the Zarr reader path has its own tests).

const DEFAULT_SIZE = 32;

const NORMALIZATION: Normalization = {
  lengthRef: 1,
  timeRef: 1,
  velocityRef: 1,
  bFieldRef: 1,
  eFieldRef: 1,
  densityRef: 1,
  massRef: 1,
  chargeRef: 1,
  speedOfLight: Number.POSITIVE_INFINITY,
};

const PHYSICS: PhysicsParams = { gamma: 1, c: 1, relativistic: false, extra: {} };

function wrapComponent(name: FieldName, data: Float32Array, shape: readonly number[]): FieldArray {
  const meta = fieldInfo(name);
  return { data, shape, meta, units: meta.siUnit, latex: meta.latex, reduction: null };
}

/**
 * A Gaussian flux rope along z: axial B_3 + azimuthal B_1/B_2, so |B| is a centered blob.
 * `n` is the per-axis resolution (n³ cells); the default is the small render scaffold, while a
 * larger `n` (e.g. 256) feeds the M2 256³ raymarch gate / empty-space-skipping profiling.
 */
export function createSyntheticDataset(n: number = DEFAULT_SIZE): FieldDataset {
  const shape: readonly number[] = [n, n, n]; // field axes (x, y, z), C-order (z fastest)
  const grid: GridInfo = {
    dimensions: [n, n, n],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    geometry: "cartesian",
    axisLabels: ["x", "y", "z"],
    dt: null,
    boundary: null,
    survivingAxes: null,
    stagger: null,
  };

  const center = (n - 1) / 2;
  const sigma2 = 2 * 0.35 * 0.35;
  const b1 = new Float32Array(n * n * n);
  const b2 = new Float32Array(n * n * n);
  const b3 = new Float32Array(n * n * n);

  for (let ix = 0; ix < n; ix++) {
    const x = (ix - center) / center;
    for (let iy = 0; iy < n; iy++) {
      const y = (iy - center) / center;
      const envelope = Math.exp(-(x * x + y * y) / sigma2);
      const aziX = -y * envelope;
      const aziY = x * envelope;
      for (let iz = 0; iz < n; iz++) {
        const i = iz + n * (iy + n * ix); // C-order: z fastest (matches volumeTexture upload)
        b1[i] = aziX;
        b2[i] = aziY;
        b3[i] = envelope;
      }
    }
  }

  const fields = new Map<FieldName, FieldArray>([
    ["B_1", wrapComponent("B_1", b1, shape)],
    ["B_2", wrapComponent("B_2", b2, shape)],
    ["B_3", wrapComponent("B_3", b3, shape)],
  ]);

  return {
    fields,
    grid,
    normalization: NORMALIZATION,
    species: [],
    physics: PHYSICS,
    frame: "lab",
    transforms: {},
    metadata: {},
    step: 0,
  };
}
