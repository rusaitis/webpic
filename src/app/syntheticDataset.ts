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

const N = 32;
const SHAPE = [N, N, N] as const; // field axes (x, y, z), C-order (z fastest)

const GRID: GridInfo = {
  dimensions: [N, N, N],
  spacing: [1, 1, 1],
  origin: [0, 0, 0],
  geometry: "cartesian",
  axisLabels: ["x", "y", "z"],
  dt: null,
  boundary: null,
  survivingAxes: null,
  stagger: null,
};

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

function wrapComponent(name: FieldName, data: Float32Array): FieldArray {
  const meta = fieldInfo(name);
  return { data, shape: SHAPE, meta, units: meta.siUnit, latex: meta.latex, reduction: null };
}

/** A Gaussian flux rope along z: axial B_3 + azimuthal B_1/B_2, so |B| is a centered blob. */
export function createSyntheticDataset(): FieldDataset {
  const center = (N - 1) / 2;
  const sigma2 = 2 * 0.35 * 0.35;
  const b1 = new Float32Array(N * N * N);
  const b2 = new Float32Array(N * N * N);
  const b3 = new Float32Array(N * N * N);

  for (let ix = 0; ix < N; ix++) {
    const x = (ix - center) / center;
    for (let iy = 0; iy < N; iy++) {
      const y = (iy - center) / center;
      const envelope = Math.exp(-(x * x + y * y) / sigma2);
      const aziX = -y * envelope;
      const aziY = x * envelope;
      for (let iz = 0; iz < N; iz++) {
        const i = iz + N * (iy + N * ix); // C-order: z fastest (matches volumeTexture upload)
        b1[i] = aziX;
        b2[i] = aziY;
        b3[i] = envelope;
      }
    }
  }

  const fields = new Map<FieldName, FieldArray>([
    ["B_1", wrapComponent("B_1", b1)],
    ["B_2", wrapComponent("B_2", b2)],
    ["B_3", wrapComponent("B_3", b3)],
  ]);

  return {
    fields,
    grid: GRID,
    normalization: NORMALIZATION,
    species: [],
    physics: PHYSICS,
    frame: "lab",
    transforms: {},
    metadata: {},
    step: 0,
  };
}
