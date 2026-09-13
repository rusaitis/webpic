import type {
  FieldArray,
  FieldDataset,
  GridInfo,
  Normalization,
  PhysicsParams,
} from "@containers/field_dataset.ts";
import { destaggerToColocated } from "@data/stagger.ts";
import { logWarn } from "@schema/log.ts";
import { isCanonicalFieldName, resolveFieldMeta } from "@schema/registry.ts";
import type { FieldName } from "@schema/types.ts";
import { SCHEMA_VERSION } from "@schema/version.ts";
import * as zarr from "zarrita";
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
  mergeReservedRootAttrs,
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

function keyFor(handle: DataHandle): string {
  return handle.kind === "url" ? `url:${handle.url}` : `opfs:${handle.path}`;
}

function abortOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

// `zarr.open`'s options, with the signal omitted rather than passed as undefined —
// exactOptionalPropertyTypes rejects the latter, which is why every call site would otherwise
// spell out the same ternary.
function openOptions<K extends "group" | "array">(
  kind: K,
  signal: AbortSignal | undefined,
): { kind: K; signal?: AbortSignal } {
  return signal === undefined ? { kind } : { kind, signal };
}

interface StoreContents {
  contents(): { path: string; kind: "array" | "group" }[];
}

function hasContents(store: zarr.Readable): store is zarr.Readable & StoreContents {
  // zarrita's Readable doesn't type the optional contents() listing — only consolidated /
  // in-memory stores expose it; feature-detect.
  return typeof (store as Partial<StoreContents>).contents === "function";
}

function enumerableKeys(store: zarr.Readable): Iterable<string> | null {
  // keys() is store-impl-specific (Map-backed stores expose it); not on zarrita's Readable.
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
  // Lazily memoized per-field: the opened array + its immutable attrs (units/latex/meta).
  // Keyed by field name; populated on first read so a scrub opens/decodes each field once,
  // not once per step. Mutable contents behind a readonly handle.
  readonly fieldArrays: Map<string, Promise<OpenedField>>;
}

// Per-field invariants: the opened zarr.Array plus the attrs that don't vary across steps
// (decoded once at the data boundary, never re-parsed per timestep).
interface OpenedField {
  readonly array: zarr.Array<zarr.DataType, zarr.Readable>;
  readonly attrs: Omit<FieldArray, "data" | "shape">;
}

async function openPypicStore(
  handle: DataHandle,
  openStore: StoreOpener,
  signal: AbortSignal | undefined,
): Promise<OpenedStore> {
  const source = `Zarr store at ${sourceLabel(handle)}`;
  const store = await openStore(handle);
  signal?.throwIfAborted();

  const root = await zarr.open(store, openOptions("group", signal));
  // zarrita types Group.attrs loosely; a pypic store writes a JSON object at the root.
  const rootAttrs = root.attrs as Record<string, unknown>;
  assertPypicSchema(rootAttrs, source);

  let fields: zarr.Group<zarr.Readable>;
  try {
    fields = await zarr.open(root.resolve("fields"), openOptions("group", signal));
  } catch (error) {
    if (error instanceof zarr.NotFoundError) {
      throw new Error(`${source}: schema.version declared but no /fields group present`, {
        cause: error,
      });
    }
    throw error;
  }

  const { grid, frame, transforms } = decodeGrid(rootAttrs, source);
  const normalization = decodeNormalization(rootAttrs, source);
  const physics = decodePhysics(rootAttrs, normalization, source);
  // species/metadata are carried verbatim (decoded), typed opaque for now.
  const species = (fromJsonNative(rootAttrs.species ?? []) ?? []) as ReadonlyArray<
    Readonly<Record<string, unknown>>
  >;
  const metadata = mergeReservedRootAttrs(
    rootAttrs,
    (fromJsonNative(rootAttrs.metadata ?? {}) ?? {}) as Readonly<Record<string, unknown>>,
    source,
  );

  const fieldNames = listFieldArrayNames(store);

  let timeSteps: readonly number[] | null = null;
  try {
    const timeArr = await zarr.open(fields.resolve("time"), openOptions("array", signal));
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
    fieldArrays: new Map(),
  };
}

// Open one field's array and decode its step-invariant attrs (validation at the boundary,
// once). The opened array carries its own store + metadata, so reusing it across reads with
// different per-read signals is sound — `zarr.get` takes the live signal each step.
async function openField(
  fields: zarr.Group<zarr.Readable>,
  name: string,
  signal: AbortSignal | undefined,
): Promise<OpenedField> {
  const array = await zarr.open(fields.resolve(name), openOptions("array", signal));
  const meta = resolveFieldMeta(name);
  if (meta === undefined) {
    throw new Error(`zarr reader: "${name}" is not a known canonical field`);
  }
  const { units, latex, reduction } = decodeFieldAttrs(array.attrs, name);
  return { array, attrs: { meta, units, latex, reduction } };
}

function getOpenedField(
  store: OpenedStore,
  name: string,
  signal: AbortSignal | undefined,
): Promise<OpenedField> {
  const cached = store.fieldArrays.get(name);
  if (cached !== undefined) return cached;
  const promise = openField(store.fields, name, signal).catch((error: unknown) => {
    store.fieldArrays.delete(name); // never cache a failed/aborted open
    throw error;
  });
  store.fieldArrays.set(name, promise);
  return promise;
}

async function readField(
  store: OpenedStore,
  name: string,
  stepIndex: number,
  isMultiStep: boolean,
  signal: AbortSignal | undefined,
): Promise<FieldArray> {
  const { array, attrs } = await getOpenedField(store, name, signal);
  const ndim = array.shape.length;
  // All-null selections always return a Chunk (not a Scalar). An integer on the leading
  // axis selects one timestep and drops that axis, leaving the spatial shape.
  const spatial = ndim - (isMultiStep ? 1 : 0);
  const selection: (number | null)[] = isMultiStep
    ? [stepIndex, ...Array.from<unknown, null>({ length: spatial }, () => null)]
    : Array.from<unknown, null>({ length: ndim }, () => null);

  const chunk = await zarr.get(array, selection, abortOptions(signal));
  const data = toFloatArray(chunk.data, array.dtype, name);
  return { data, shape: chunk.shape, ...attrs };
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
    logWarn("zarr", `skipping unrecognized fields: ${skipped.join(", ")}`);
  }
}

export function createZarrReader(
  options: ZarrReaderOptions = {},
): SimulationReader & FieldListingReader {
  const openStore = options.openStore ?? defaultOpenStore;
  // Reuse opened metadata/listing across calls for the same source.
  const opened = new Map<string, Promise<OpenedStore>>();

  function getOpened(handle: DataHandle, signal: AbortSignal | undefined): Promise<OpenedStore> {
    const key = keyFor(handle);
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
      signal?.throwIfAborted();
      const store = await getOpened(handle, signal);
      signal?.throwIfAborted();

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
        signal?.throwIfAborted();
        fields.set(name, await readField(store, name, step, isMultiStep, signal));
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

// Cheap probe for the reader registry: a pypic store iff schema.version matches and a
// /fields group exists (metadata-only, no chunk reads). Injectable for testing.
export function createZarrConfidence(openStore: StoreOpener = defaultOpenStore): ConfidenceFn {
  return async (handle, signal) => {
    try {
      const store = await openStore(handle);
      const root = await zarr.open(store, openOptions("group", signal));
      // zarrita types attrs as opaque; read the schema-version discriminator structurally.
      const schema = (root.attrs as { schema?: { version?: unknown } }).schema;
      if (schema?.version !== SCHEMA_VERSION) return 0;
      await zarr.open(root.resolve("fields"), openOptions("group", signal));
      return 1;
    } catch {
      return 0; // not a pypic store (or unreachable/aborted) — the registry reports 0 either way
    }
  };
}
