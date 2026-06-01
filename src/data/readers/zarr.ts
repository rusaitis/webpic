import type {
  FieldArray,
  FieldDataset,
  GridInfo,
  Normalization,
  PhysicsParams,
} from "@containers/field_dataset.ts";
import type { FieldName } from "@schema/types.ts";
import { SCHEMA_VERSION } from "@schema/version.ts";
import * as zarr from "zarrita";
import { destaggerToColocated } from "../stagger.ts";
import type {
  ConfidenceFn,
  DataHandle,
  FieldListingReader,
  ReadTimestepOptions,
  SimulationReader,
} from "./_protocols.ts";
import {
  assertPypicSchema,
  decodeFieldAttrs,
  decodeGrid,
  decodeNormalization,
  decodePhysics,
  fromJsonNative,
  isCanonicalFieldName,
  resolveFieldMeta,
} from "./decode.ts";

// Zarr v3 reader for pypic-blessed stores (mirrors pypic.io.zarr.from_zarr). Produces
// canonical-named FieldDatasets, destaggering Yee-mesh components to the co-located grid
// on load (identity fast-path for already-co-located stores — i.e. every pypic store).

export type StoreOpener = (handle: DataHandle) => zarr.Readable | Promise<zarr.Readable>;

export interface ZarrReaderOptions {
  /** Inject the storage backend (tests pass an in-memory store); defaults to FetchStore. */
  readonly openStore?: StoreOpener;
}

async function defaultOpenStore(handle: DataHandle): Promise<zarr.Readable> {
  if (handle.kind === "url") {
    // pypic always consolidates → one metadata fetch and a listable store; falls back
    // to the raw store when no consolidated metadata is present.
    return zarr.withMaybeConsolidatedMetadata(new zarr.FetchStore(handle.url));
  }
  throw new Error(`zarr reader: handle kind "${handle.kind}" is not supported yet`);
}

function sourceLabel(handle: DataHandle): string {
  return handle.kind === "url" ? handle.url : handle.path;
}

function handleKey(handle: DataHandle): string {
  return handle.kind === "url" ? `url:${handle.url}` : `opfs:${handle.path}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
}

function getOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

interface StoreContents {
  contents(): { path: string; kind: "array" | "group" }[];
}

function hasContents(store: zarr.Readable): store is zarr.Readable & StoreContents {
  return typeof (store as Partial<StoreContents>).contents === "function";
}

function enumerableKeys(store: zarr.Readable): Iterable<string> | null {
  const keys = (store as { keys?: () => Iterable<string> }).keys;
  return typeof keys === "function" ? keys.call(store) : null;
}

const FIELD_ARRAY_PATH = /^\/fields\/([^/]+)$/;
const FIELD_ARRAY_META_KEY = /^\/fields\/([^/]+)\/zarr\.json$/;

// On-disk array names under /fields (fields + dimension coordinates). Consolidated
// stores expose contents(); local Map-backed stores are enumerated by key. Remote
// non-consolidated stores can't be listed — a documented limitation (R2).
function listFieldArrayNames(store: zarr.Readable): string[] {
  if (hasContents(store)) {
    const names: string[] = [];
    for (const entry of store.contents()) {
      const match = FIELD_ARRAY_PATH.exec(entry.path);
      if (entry.kind === "array" && match?.[1] !== undefined) names.push(match[1]);
    }
    return names;
  }
  const keys = enumerableKeys(store);
  if (keys !== null) {
    const names = new Set<string>();
    for (const key of keys) {
      const match = FIELD_ARRAY_META_KEY.exec(key);
      if (match?.[1] !== undefined) names.add(match[1]);
    }
    return [...names];
  }
  throw new Error(
    "zarr reader: cannot list /fields — store is neither consolidated nor enumerable",
  );
}

// Disk dtype preserved: f32 (render) / f64 (TS compute reference) pass through
// zero-copy; other numeric dtypes widen to f64 losslessly; non-numeric throws.
function toFloatArray(
  data: zarr.TypedArray<zarr.DataType>,
  dtype: zarr.DataType,
  name: string,
): Float32Array | Float64Array {
  if (data instanceof Float32Array) return data;
  if (data instanceof Float64Array) return data;
  if (data instanceof BigInt64Array || data instanceof BigUint64Array) {
    const out = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = Number(data[i]);
    return out;
  }
  if (
    data instanceof Int8Array ||
    data instanceof Int16Array ||
    data instanceof Int32Array ||
    data instanceof Uint8Array ||
    data instanceof Uint16Array ||
    data instanceof Uint32Array ||
    data instanceof Uint8ClampedArray
  ) {
    return Float64Array.from(data);
  }
  throw new Error(`zarr reader: field "${name}" has non-numeric dtype "${dtype}"`);
}

interface OpenedStore {
  readonly fields: zarr.Group<zarr.Readable>;
  readonly fieldNames: readonly string[];
  readonly coordNames: ReadonlySet<string>;
  readonly timeSteps: readonly number[] | null; // null = single-step
  readonly grid: GridInfo;
  readonly normalization: Normalization;
  readonly physics: PhysicsParams;
  readonly species: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly frame: string;
  readonly transforms: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

async function openPypicStore(
  handle: DataHandle,
  openStore: StoreOpener,
  signal: AbortSignal | undefined,
): Promise<OpenedStore> {
  const source = `Zarr store at ${sourceLabel(handle)}`;
  const store = await openStore(handle);
  throwIfAborted(signal);

  const root = await zarr.open(
    store,
    signal === undefined ? { kind: "group" } : { kind: "group", signal },
  );
  const rootAttrs = root.attrs as Record<string, unknown>;
  assertPypicSchema(rootAttrs, source);

  let fields: zarr.Group<zarr.Readable>;
  try {
    fields = await zarr.open(
      root.resolve("fields"),
      signal === undefined ? { kind: "group" } : { kind: "group", signal },
    );
  } catch (error) {
    if (error instanceof zarr.NotFoundError) {
      throw new Error(`${source}: schema.version declared but no /fields group present`);
    }
    throw error;
  }

  const { grid, frame, transforms } = decodeGrid(rootAttrs, source);
  const normalization = decodeNormalization(rootAttrs, source);
  const physics = decodePhysics(rootAttrs, normalization, source);
  // species/metadata are carried verbatim (decoded), typed opaque in M1.1.
  const species = (fromJsonNative(rootAttrs.species ?? []) ?? []) as ReadonlyArray<
    Readonly<Record<string, unknown>>
  >;
  const metadata = (fromJsonNative(rootAttrs.metadata ?? {}) ?? {}) as Readonly<
    Record<string, unknown>
  >;

  const fieldNames = listFieldArrayNames(store);

  let timeSteps: readonly number[] | null = null;
  try {
    const timeArr = await zarr.open(
      fields.resolve("time"),
      signal === undefined ? { kind: "array" } : { kind: "array", signal },
    );
    const nt = timeArr.shape[0] ?? 0;
    timeSteps = Array.from({ length: nt }, (_, i) => i);
  } catch (error) {
    if (!(error instanceof zarr.NotFoundError)) throw error;
  }

  const coordNames = new Set<string>([...grid.axisLabels, "time"]);
  return {
    fields,
    fieldNames,
    coordNames,
    timeSteps,
    grid,
    normalization,
    physics,
    species,
    frame,
    transforms,
    metadata,
  };
}

async function readField(
  fields: zarr.Group<zarr.Readable>,
  name: string,
  stepIndex: number,
  isMultiStep: boolean,
  signal: AbortSignal | undefined,
): Promise<FieldArray> {
  const arr = await zarr.open(
    fields.resolve(name),
    signal === undefined ? { kind: "array" } : { kind: "array", signal },
  );
  const ndim = arr.shape.length;
  // All-null selections always return a Chunk (not a Scalar). An integer on the leading
  // axis selects one timestep and drops that axis, leaving the spatial shape.
  const spatial = ndim - (isMultiStep ? 1 : 0);
  const selection: (number | null)[] = isMultiStep
    ? [stepIndex, ...Array.from<unknown, null>({ length: spatial }, () => null)]
    : Array.from<unknown, null>({ length: ndim }, () => null);

  const chunk = await zarr.get(arr, selection, getOpts(signal));
  const data = toFloatArray(chunk.data, arr.dtype, name);

  const meta = resolveFieldMeta(name);
  if (meta === undefined) {
    throw new Error(`zarr reader: "${name}" is not a known canonical field`);
  }
  const { units, latex, reduction } = decodeFieldAttrs(arr.attrs, name);
  return { data, shape: chunk.shape, meta, units, latex, reduction };
}

function partitionFields(
  fieldNames: readonly string[],
  coordNames: ReadonlySet<string>,
): { accepted: string[]; skipped: string[] } {
  const accepted: string[] = [];
  const skipped: string[] = [];
  for (const name of fieldNames) {
    if (coordNames.has(name)) continue;
    if (isCanonicalFieldName(name)) accepted.push(name);
    else skipped.push(name);
  }
  return { accepted, skipped };
}

function warnSkipped(skipped: readonly string[]): void {
  if (skipped.length > 0) {
    console.warn(`zarr reader: skipping unrecognized fields: ${skipped.join(", ")}`);
  }
}

export function createZarrReader(
  options: ZarrReaderOptions = {},
): SimulationReader & FieldListingReader {
  const openStore = options.openStore ?? defaultOpenStore;
  // Reuse opened metadata/listing across calls for the same source.
  const opened = new Map<string, Promise<OpenedStore>>();

  function getOpened(handle: DataHandle, signal: AbortSignal | undefined): Promise<OpenedStore> {
    const key = handleKey(handle);
    const cached = opened.get(key);
    if (cached !== undefined) return cached;
    const promise = openPypicStore(handle, openStore, signal).catch((error: unknown) => {
      opened.delete(key); // never cache a failed/aborted open
      throw error;
    });
    opened.set(key, promise);
    return promise;
  }

  async function availableFields(handle: DataHandle): Promise<FieldName[]> {
    const store = await getOpened(handle, undefined);
    const { accepted, skipped } = partitionFields(store.fieldNames, store.coordNames);
    warnSkipped(skipped);
    return accepted.sort();
  }

  return {
    id: "zarr",

    async availableTimesteps(handle) {
      const store = await getOpened(handle, undefined);
      return store.timeSteps === null ? [0] : [...store.timeSteps];
    },

    async readTimestep(handle, step, readOptions?: ReadTimestepOptions) {
      const signal = readOptions?.signal;
      throwIfAborted(signal);
      const store = await getOpened(handle, signal);
      throwIfAborted(signal);

      const steps = store.timeSteps;
      const isMultiStep = steps !== null;
      if (steps !== null) {
        const last = steps.length - 1;
        if (step < 0 || step > last) {
          throw new Error(`zarr reader: step ${step} out of range [0, ${last}]`);
        }
      } else if (step !== 0) {
        throw new Error(`zarr reader: single-step store has only step 0, got ${step}`);
      }

      const requested = readOptions?.fields;
      let names: string[];
      if (requested !== undefined) {
        for (const name of requested) {
          if (!isCanonicalFieldName(name)) {
            throw new Error(
              `zarr reader: requested field "${name}" is not a known canonical field`,
            );
          }
          if (!store.fieldNames.includes(name)) {
            throw new Error(`zarr reader: requested field "${name}" is not present in the store`);
          }
        }
        names = [...requested];
      } else {
        const { accepted, skipped } = partitionFields(store.fieldNames, store.coordNames);
        warnSkipped(skipped);
        names = accepted;
      }

      const fields = new Map<FieldName, FieldArray>();
      for (const name of names) {
        throwIfAborted(signal);
        fields.set(name, await readField(store.fields, name, step, isMultiStep, signal));
      }

      const dataset: FieldDataset = {
        fields,
        grid: store.grid,
        normalization: store.normalization,
        species: store.species,
        physics: store.physics,
        frame: store.frame,
        transforms: store.transforms,
        metadata: store.metadata,
        step,
      };
      return destaggerToColocated(dataset);
    },

    availableFields(handle, _step) {
      return availableFields(handle);
    },

    async availableFieldsMapping(handle, _step) {
      const accepted = await availableFields(handle);
      const mapping: Record<string, string | null> = {};
      for (const name of accepted) mapping[name] = name; // pypic writes canonical names
      return mapping;
    },
  };
}

// Cheap probe for the M1.2 registry: a pypic store iff schema.version matches and a
// /fields group exists (metadata-only, no chunk reads). Injectable for testing.
export function createZarrConfidence(openStore: StoreOpener = defaultOpenStore): ConfidenceFn {
  return async (handle) => {
    try {
      const store = await openStore(handle);
      const root = await zarr.open(store, { kind: "group" });
      const schema = (root.attrs as { schema?: { version?: unknown } }).schema;
      if (schema?.version !== SCHEMA_VERSION) return 0;
      await zarr.open(root.resolve("fields"), { kind: "group" });
      return 1;
    } catch {
      return 0;
    }
  };
}

export const zarrConfidence: ConfidenceFn = createZarrConfidence();
