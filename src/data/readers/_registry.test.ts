import { SCHEMA_VERSION } from "@schema/version.ts";
import { describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";
import type { ConfidenceFn, DataHandle, SimulationReader } from "./_protocols.ts";
import { createReaderRegistry, openSimulation, probeReaders, registerReader } from "./_registry.ts";
import { registerBuiltinReaders } from "./builtins.ts";

const HANDLE: DataHandle = { kind: "url", url: "mem://test" };

// Minimal SimulationReader stub — readTimestep is never reached in registry tests (selection only).
function fakeReader(id: string): SimulationReader {
  return {
    id,
    async readTimestep() {
      throw new Error(`fakeReader(${id}): readTimestep not exercised here`);
    },
    async availableTimesteps() {
      return [0];
    },
  };
}

const confidence =
  (score: number): ConfidenceFn =>
  async () =>
    score;

const throwingConfidence: ConfidenceFn = async () => {
  throw new Error("probe blew up");
};

// Smallest store zarrConfidence accepts: schema.version match + a /fields group (no chunks).
async function pypicRootStore(): Promise<Map<string, Uint8Array>> {
  const store = new Map<string, Uint8Array>();
  const root = zarr.root(store);
  await zarr.create(root, { attributes: { schema: { version: SCHEMA_VERSION } } });
  await zarr.create(root.resolve("fields"), { attributes: {} });
  return store;
}

describe("ReaderRegistry — selection", () => {
  it("throws an actionable error when empty", async () => {
    const reg = createReaderRegistry();
    await expect(reg.open(HANDLE)).rejects.toThrow(/no readers registered/);
    await expect(reg.open(HANDLE)).rejects.toThrow(/registerBuiltinReaders/);
  });

  it("picks the highest-confidence reader", async () => {
    const reg = createReaderRegistry();
    const low = fakeReader("low");
    const high = fakeReader("high");
    reg.register(low, confidence(0.2));
    reg.register(high, confidence(0.9));
    expect(await reg.open(HANDLE)).toBe(high);
  });

  it("ignores zero-confidence readers", async () => {
    const reg = createReaderRegistry();
    const yes = fakeReader("yes");
    reg.register(fakeReader("no"), confidence(0));
    reg.register(yes, confidence(0.5));
    expect(await reg.open(HANDLE)).toBe(yes);
  });

  it("breaks confidence ties alphabetically by id (deterministic)", async () => {
    const reg = createReaderRegistry();
    const beta = fakeReader("beta");
    const alpha = fakeReader("alpha");
    reg.register(beta, confidence(0.5));
    reg.register(alpha, confidence(0.5));
    expect(await reg.open(HANDLE)).toBe(alpha);
  });

  it("throws a diagnostic listing every probe when none match", async () => {
    const reg = createReaderRegistry();
    reg.register(fakeReader("alpha"), confidence(0));
    reg.register(fakeReader("beta"), confidence(0));
    await expect(reg.open(HANDLE)).rejects.toThrow(/no reader recognized/);
    await expect(reg.open(HANDLE)).rejects.toThrow(/alpha: 0\.00[\s\S]*beta: 0\.00/);
  });
});

describe("ReaderRegistry — probing", () => {
  it("never rejects when a probe throws; captures the error at confidence 0", async () => {
    const reg = createReaderRegistry();
    const good = fakeReader("good");
    reg.register(fakeReader("boom"), throwingConfidence);
    reg.register(good, confidence(1));

    const probes = await reg.probe(HANDLE);
    const boom = probes.find((p) => p.id === "boom");
    expect(boom).toEqual({ id: "boom", confidence: 0, error: "probe blew up" });
    // A throwing probe is never selected.
    expect(await reg.open(HANDLE)).toBe(good);
  });

  it("reports probes in registration order", async () => {
    const reg = createReaderRegistry();
    reg.register(fakeReader("first"), confidence(0.1));
    reg.register(fakeReader("second"), confidence(0.2));
    expect((await reg.probe(HANDLE)).map((p) => p.id)).toEqual(["first", "second"]);
  });
});

describe("ReaderRegistry — registration lifecycle", () => {
  it("warns and overwrites on duplicate id; open uses the replacement", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = createReaderRegistry();
    const original = fakeReader("zarr");
    const replacement = fakeReader("zarr");
    reg.register(original, confidence(1));
    reg.register(replacement, confidence(1));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('overwriting existing reader "zarr"'),
    );
    expect(reg.ids()).toEqual(["zarr"]);
    expect(await reg.open(HANDLE)).toBe(replacement);
    warn.mockRestore();
  });

  it("disposer unregisters the reader", async () => {
    const reg = createReaderRegistry();
    const dispose = reg.register(fakeReader("zarr"), confidence(1));
    expect(reg.ids()).toEqual(["zarr"]);
    dispose();
    expect(reg.ids()).toEqual([]);
  });

  it("disposer is identity-safe: disposing a stale handle keeps the replacement", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = createReaderRegistry();
    const replacement = fakeReader("zarr");
    const disposeStale = reg.register(fakeReader("zarr"), confidence(1));
    reg.register(replacement, confidence(1));
    disposeStale();
    expect(reg.ids()).toEqual(["zarr"]);
    expect(await reg.open(HANDLE)).toBe(replacement);
    vi.restoreAllMocks();
  });

  it("clear() empties the registry", () => {
    const reg = createReaderRegistry();
    reg.register(fakeReader("a"), confidence(1));
    reg.register(fakeReader("b"), confidence(1));
    reg.clear();
    expect(reg.ids()).toEqual([]);
  });

  it("createReaderRegistry() instances are isolated", async () => {
    const a = createReaderRegistry();
    const b = createReaderRegistry();
    a.register(fakeReader("only-in-a"), confidence(1));
    expect(a.ids()).toEqual(["only-in-a"]);
    expect(b.ids()).toEqual([]);
    await expect(b.open(HANDLE)).rejects.toThrow(/no readers registered/);
  });
});

describe("default registry facade", () => {
  it("registerReader / openSimulation / probeReaders delegate to the module registry", async () => {
    const reader = fakeReader("facade-reader");
    const dispose = registerReader(reader, confidence(1));
    try {
      expect((await probeReaders(HANDLE)).some((p) => p.id === "facade-reader")).toBe(true);
      expect(await openSimulation(HANDLE)).toBe(reader);
    } finally {
      dispose(); // keep the module-level default registry clean for other tests
    }
  });
});

describe("registerBuiltinReaders", () => {
  it("registers the zarr reader and selects it for a pypic store", async () => {
    const store = await pypicRootStore();
    const reg = createReaderRegistry();
    const dispose = registerBuiltinReaders(reg, { openStore: () => store });

    expect(reg.ids()).toContain("zarr");
    const reader = await reg.open(HANDLE);
    expect(reader.id).toBe("zarr");

    dispose();
    expect(reg.ids()).toEqual([]);
  });

  it("does not select zarr for a non-pypic store", async () => {
    const store = new Map<string, Uint8Array>();
    await zarr.create(zarr.root(store), { attributes: { not: "pypic" } });
    const reg = createReaderRegistry();
    registerBuiltinReaders(reg, { openStore: () => store });
    await expect(reg.open(HANDLE)).rejects.toThrow(/no reader recognized/);
  });
});
