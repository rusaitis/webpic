import { afterEach, describe, expect, it, vi } from "vitest";
import { type LogSink, logError, logWarn, rejectionLogger, setLogSink } from "./log.ts";

interface Captured {
  readonly level: "warn" | "error";
  readonly scope: string;
  readonly message: string;
  readonly detail: unknown;
}

function recordingSink(into: Captured[]): LogSink {
  return {
    warn: (scope, message, detail) => into.push({ level: "warn", scope, message, detail }),
    error: (scope, message, detail) => into.push({ level: "error", scope, message, detail }),
  };
}

afterEach(() => {
  setLogSink(null);
  vi.restoreAllMocks();
});

describe("setLogSink", () => {
  it("routes warnings and errors to the installed sink", () => {
    const captured: Captured[] = [];
    setLogSink(recordingSink(captured));

    logWarn("zarr", "skipping unknown key", { key: "nope" });
    logError("render worker", "device lost");

    expect(captured).toEqual([
      { level: "warn", scope: "zarr", message: "skipping unknown key", detail: { key: "nope" } },
      { level: "error", scope: "render worker", message: "device lost", detail: undefined },
    ]);
  });

  it("restores the console sink on null", () => {
    const captured: Captured[] = [];
    setLogSink(recordingSink(captured));
    setLogSink(null);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    logWarn("theme", "pref unreadable");

    expect(captured).toEqual([]);
    expect(spy).toHaveBeenCalledWith("[webpic:theme] pref unreadable");
  });

  it("passes a detail through to the console sink as a second argument", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = new Error("boom");

    logError("boot", "gpu probe failed", cause);

    expect(spy).toHaveBeenCalledWith("[webpic:boot] gpu probe failed", cause);
  });
});

describe("rejectionLogger", () => {
  it("reports the rejection value as the error detail", () => {
    const captured: Captured[] = [];
    setLogSink(recordingSink(captured));
    const cause = new Error("nope");

    rejectionLogger("app", "dataset open failed")(cause);

    expect(captured).toEqual([
      { level: "error", scope: "app", message: "dataset open failed", detail: cause },
    ]);
  });
});
