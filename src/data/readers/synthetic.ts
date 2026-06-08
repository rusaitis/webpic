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

// A synthetic multi-step source behind the SimulationReader protocol — a time-varying Gaussian flux
// rope, no data files (CLAUDE.md "synthetic over real"). It gives the streaming worker a real
// openSimulation/readTimestep/AbortSignal path to drive (the shape a Zarr source will use) while
// staying deterministic and cheap to regenerate (so scrub-back re-reads are free). Handle:
// `synthetic://fluxrope?n=<size>&steps=<count>`.

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

interface SyntheticParams {
  readonly n: number;
  readonly steps: number;
}

// Parse a synthetic handle, or null if it isn't one — the confidence probe + reader both gate on it.
function parseHandle(handle: DataHandle): SyntheticParams | null {
  if (handle.kind !== "url" || !handle.url.startsWith(SCHEME)) return null;
  const query = handle.url.slice(handle.url.indexOf("?") + 1);
  const params = new URLSearchParams(query);
  const n = Number.parseInt(params.get("n") ?? "", 10);
  const steps = Number.parseInt(params.get("steps") ?? "", 10);
  return {
    n: Number.isInteger(n) && n >= 2 ? n : DEFAULT_SYNTHETIC_N,
    steps: Number.isInteger(steps) && steps >= 1 ? steps : DEFAULT_SYNTHETIC_STEPS,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
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

const COMPONENTS: readonly FieldName[] = ["B_1", "B_2", "B_3"];

export function createSyntheticReader(): SimulationReader & FieldListingReader {
  return {
    id: READER_ID,
    async availableTimesteps(handle) {
      const params = parseHandle(handle);
      if (params === null) throw new Error(`${READER_ID}: not a synthetic handle`);
      return Array.from({ length: params.steps }, (_, i) => i);
    },
    async readTimestep(handle, step, options?: ReadTimestepOptions) {
      const params = parseHandle(handle);
      if (params === null) throw new Error(`${READER_ID}: not a synthetic handle`);
      if (step < 0 || step >= params.steps) {
        throw new RangeError(`${READER_ID}: step ${step} out of range [0, ${params.steps})`);
      }
      // Async boundary so an abort racing a queued read is honored before any work (the loop aborts
      // reads the user scrubbed past); the generation itself is synchronous + cheap.
      await Promise.resolve();
      throwIfAborted(options?.signal);
      const dataset = syntheticStep(params.n, step, params.steps);
      throwIfAborted(options?.signal);
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
