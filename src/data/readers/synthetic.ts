import type {
  FieldArray,
  FieldDataset,
  GridInfo,
  Normalization,
  PhysicsParams,
} from "@containers/field_dataset.ts";
import { fieldInfo } from "@schema/registry.ts";
import type { FieldName } from "@schema/types.ts";
import type {
  ConfidenceFn,
  DataHandle,
  FieldListingReader,
  ReadTimestepOptions,
  SimulationReader,
} from "./_protocols.ts";
import type { ReaderRegistry } from "./_registry.ts";
import { registerReader } from "./_registry.ts";

// Synthetic sources behind the SimulationReader protocol — no data files (CLAUDE.md "synthetic over
// real"). They give the streaming worker a real openSimulation/readTimestep/AbortSignal path to drive
// (the shape a Zarr source will use) while staying deterministic and cheap to regenerate (so scrub-back
// re-reads are free). Two handles:
//   • `synthetic://fluxrope?n=<size>&steps=<count>` — a time-varying Gaussian flux rope (cubic n³).
//   • `synthetic://dipole` — magviz's static Earth dipole on its default non-cubic grid (single step).

const READER_ID = "synthetic-fluxrope";
const SCHEME = "synthetic://";
export const DEFAULT_SYNTHETIC_N = 32;
export const DEFAULT_SYNTHETIC_STEPS = 16;

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

/** A `synthetic://fluxrope` handle sized `n³` over `steps` timesteps. */
export function syntheticHandle(
  n: number = DEFAULT_SYNTHETIC_N,
  steps: number = DEFAULT_SYNTHETIC_STEPS,
): DataHandle {
  return { kind: "url", url: `${SCHEME}fluxrope?n=${n}&steps=${steps}` };
}

/** A `synthetic://dipole` handle — magviz's static Earth dipole on its default non-cubic grid. */
export function dipoleHandle(): DataHandle {
  return { kind: "url", url: `${SCHEME}dipole` };
}

type SyntheticHandle =
  | { readonly kind: "fluxrope"; readonly n: number; readonly steps: number }
  | { readonly kind: "dipole" };

// Parse a synthetic handle, or null if it isn't one — the confidence probe + reader both gate on it.
// The path between `synthetic://` and any `?query` selects the generator; a bare/unknown path is the
// flux rope (back-compat with handles minted before the dipole landed).
function parseHandle(handle: DataHandle): SyntheticHandle | null {
  if (handle.kind !== "url" || !handle.url.startsWith(SCHEME)) return null;
  const rest = handle.url.slice(SCHEME.length);
  const queryAt = rest.indexOf("?");
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  if (path === "dipole") return { kind: "dipole" };
  const params = new URLSearchParams(queryAt === -1 ? "" : rest.slice(queryAt + 1));
  const n = Number.parseInt(params.get("n") ?? "", 10);
  const steps = Number.parseInt(params.get("steps") ?? "", 10);
  return {
    kind: "fluxrope",
    n: Number.isInteger(n) && n >= 2 ? n : DEFAULT_SYNTHETIC_N,
    steps: Number.isInteger(steps) && steps >= 1 ? steps : DEFAULT_SYNTHETIC_STEPS,
  };
}

function wrapComponent(name: FieldName, data: Float32Array, shape: readonly number[]): FieldArray {
  const meta = fieldInfo(name);
  return { data, shape: [...shape], meta, units: meta.siUnit, latex: meta.latex, reduction: null };
}

function makeGrid(n: number): GridInfo {
  return {
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
}

/**
 * A Gaussian flux rope along z whose center drifts in x and whose axial amplitude pulses with the
 * timestep phase, so `|B|` visibly evolves as you scrub. `step 0` (phase 0 → no drift, unit
 * amplitude) reproduces the static scaffold field exactly — so seeding the store from step 0 on the
 * main thread and streaming step 0 from the worker agree (no flash on scrub-back to 0).
 */
export function syntheticStep(n: number, step: number, steps: number): FieldDataset {
  const shape: readonly number[] = [n, n, n]; // field axes (x, y, z), C-order (z fastest)
  const phase = steps > 1 ? (2 * Math.PI * step) / steps : 0;
  const driftX = 0.3 * Math.sin(phase); // rope center drifts laterally in normalized coords
  const axial = 0.6 + 0.4 * Math.cos(phase); // axial amplitude pulses (1.0 at phase 0)

  const center = (n - 1) / 2;
  const sigma2 = 2 * 0.35 * 0.35;
  const b1 = new Float32Array(n * n * n);
  const b2 = new Float32Array(n * n * n);
  const b3 = new Float32Array(n * n * n);

  for (let ix = 0; ix < n; ix++) {
    const x = (ix - center) / center - driftX;
    for (let iy = 0; iy < n; iy++) {
      const y = (iy - center) / center;
      const envelope = Math.exp(-(x * x + y * y) / sigma2);
      const aziX = -y * envelope;
      const aziY = x * envelope;
      const ax = axial * envelope;
      for (let iz = 0; iz < n; iz++) {
        const i = iz + n * (iy + n * ix); // C-order: z fastest (matches volumeTexture upload)
        b1[i] = aziX;
        b2[i] = aziY;
        b3[i] = ax;
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
    grid: makeGrid(n),
    normalization: NORMALIZATION,
    species: [],
    physics: PHYSICS,
    frame: "lab",
    transforms: {},
    metadata: {},
    step,
  };
}

// Earth dipole field on magviz's default grid (data-processing/generate_dipole_data.py): moment along
// +z, sign-flipped to put magnetic north at −z. Inputs in Earth radii, output in nT; the inner region
// (r < 1.1 R_E) is zeroed to dodge the r=0 singularity. Bounds are non-cubic (x∈[-10,5], y,z∈[-5,5]) —
// the renderer scales the volume box to this aspect (store `worldHalfExtent`). One static timestep.
const DIPOLE_DIMS = [150, 100, 100] as const; // 0.1 R_E cells spanning the magviz extent
const DIPOLE_SPACING = 0.1;
const DIPOLE_ORIGIN = [-10, -5, -5] as const;
const DIPOLE_INNER_CUTOFF = 1.1; // R_E — below this the field is zeroed (planet interior + buffer)
// B(nT) = (μ0/4π)·M·1e9 / R_E³ · shape — the analytic dipole scale, matching magviz's constants.
const DIPOLE_SCALE_NT = (1e-7 * 7.8e22 * 1e9) / 6.371e6 ** 3; // ≈ 3.016e4 nT·R_E³
const DIPOLE_ORIENTATION = -1; // magnetic north at −z (magviz convention)

function makeDipoleGrid(): GridInfo {
  return {
    dimensions: [...DIPOLE_DIMS],
    spacing: [DIPOLE_SPACING, DIPOLE_SPACING, DIPOLE_SPACING],
    origin: [...DIPOLE_ORIGIN],
    geometry: "cartesian",
    axisLabels: ["x", "y", "z"],
    dt: null,
    boundary: null,
    survivingAxes: null,
    stagger: null,
  };
}

/** The static Earth dipole dataset — the `synthetic://dipole` source's only timestep. */
export function dipoleStep(): FieldDataset {
  const [nx, ny, nz] = DIPOLE_DIMS;
  const shape: readonly number[] = [nx, ny, nz];
  const b1 = new Float32Array(nx * ny * nz);
  const b2 = new Float32Array(nx * ny * nz);
  const b3 = new Float32Array(nx * ny * nz);
  const common = DIPOLE_ORIENTATION * DIPOLE_SCALE_NT;

  for (let ix = 0; ix < nx; ix++) {
    const x = DIPOLE_ORIGIN[0] + (ix + 0.5) * DIPOLE_SPACING; // cell centers — singularity off-node
    for (let iy = 0; iy < ny; iy++) {
      const y = DIPOLE_ORIGIN[1] + (iy + 0.5) * DIPOLE_SPACING;
      for (let iz = 0; iz < nz; iz++) {
        const z = DIPOLE_ORIGIN[2] + (iz + 0.5) * DIPOLE_SPACING;
        const i = iz + nz * (iy + ny * ix); // C-order: z fastest (matches volumeTexture upload)
        const r2 = x * x + y * y + z * z;
        const r = Math.sqrt(r2);
        if (r < DIPOLE_INNER_CUTOFF) continue; // zeroed inside the cutoff (arrays start at 0)
        const c = common / (r2 * r2 * r); // common / r⁵
        b1[i] = c * 3 * x * z;
        b2[i] = c * 3 * y * z;
        b3[i] = c * (3 * z * z - r2);
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
    grid: makeDipoleGrid(),
    normalization: NORMALIZATION,
    species: [],
    physics: PHYSICS,
    frame: "lab",
    transforms: {},
    metadata: {},
    step: 0,
  };
}

const COMPONENTS: readonly FieldName[] = ["B_1", "B_2", "B_3"];

function datasetForStep(parsed: SyntheticHandle, step: number): FieldDataset {
  return parsed.kind === "dipole" ? dipoleStep() : syntheticStep(parsed.n, step, parsed.steps);
}

function stepCountOf(parsed: SyntheticHandle): number {
  return parsed.kind === "dipole" ? 1 : parsed.steps;
}

export function createSyntheticReader(): SimulationReader & FieldListingReader {
  return {
    id: READER_ID,
    async availableTimesteps(handle) {
      const parsed = parseHandle(handle);
      if (parsed === null) throw new Error(`${READER_ID}: not a synthetic handle`);
      return Array.from({ length: stepCountOf(parsed) }, (_, i) => i);
    },
    async readTimestep(handle, step, options?: ReadTimestepOptions) {
      const parsed = parseHandle(handle);
      if (parsed === null) throw new Error(`${READER_ID}: not a synthetic handle`);
      const steps = stepCountOf(parsed);
      if (step < 0 || step >= steps) {
        throw new RangeError(`${READER_ID}: step ${step} out of range [0, ${steps})`);
      }
      // Async boundary so an abort racing a queued read is honored before any work (the loop aborts
      // reads the user scrubbed past); the generation itself is synchronous + cheap.
      await Promise.resolve();
      options?.signal?.throwIfAborted();
      const dataset = datasetForStep(parsed, step);
      options?.signal?.throwIfAborted();
      if (options?.fields === undefined) return dataset;
      // Restrict to requested fields, rejecting unknown names loudly (mirrors the zarr reader).
      const fields = new Map<FieldName, FieldArray>();
      for (const name of options.fields) {
        const field = dataset.fields.get(name);
        if (field === undefined) {
          throw new Error(`${READER_ID}: unknown field "${name}" (has ${COMPONENTS.join(", ")})`);
        }
        fields.set(name, field);
      }
      return { ...dataset, fields };
    },
    async availableFields(handle) {
      const params = parseHandle(handle);
      if (params === null) throw new Error(`${READER_ID}: not a synthetic handle`);
      return [...COMPONENTS];
    },
    async availableFieldsMapping() {
      // Every field is synthesized — no on-disk name.
      return Object.fromEntries(COMPONENTS.map((name) => [name, null]));
    },
  };
}

// 1.0 for a synthetic handle, 0 otherwise — so a real zarr/url never resolves to this reader.
export const syntheticConfidence: ConfidenceFn = async (handle) =>
  parseHandle(handle) === null ? 0 : 1;

/** Register the synthetic reader (process-wide default or an injected registry). */
export function registerSyntheticReader(registry?: ReaderRegistry): () => void {
  const register = registry === undefined ? registerReader : registry.register.bind(registry);
  return register(createSyntheticReader(), syntheticConfidence);
}
