// The one diagnostics seam every layer can reach (schema is the DAG root): warnings and errors on
// genuine failure paths route here instead of raw console calls, so an embedding host can redirect
// or silence webpic once via setLogSink. Not a general logger — hot paths and debug output stay out.

// Closed set so a scope is a compile error rather than a new spelling of an existing one: layer
// name for a layer, "<x> worker" for a worker realm, "boot"/"app" for the main thread.
export type LogScope =
  | "boot"
  | "app"
  | "zarr"
  | "readers"
  | "theme"
  | "trace"
  | "calibration"
  | "render worker"
  | "data worker";

export interface LogSink {
  readonly warn: (scope: LogScope, message: string, detail?: unknown) => void;
  readonly error: (scope: LogScope, message: string, detail?: unknown) => void;
}

function emit(
  write: (...args: readonly unknown[]) => void,
  scope: LogScope,
  message: string,
  detail: unknown,
): void {
  const line = `[webpic:${scope}] ${message}`;
  if (detail === undefined) write(line);
  else write(line, detail);
}

const consoleSink: LogSink = {
  warn: (scope, message, detail) => emit(console.warn, scope, message, detail),
  error: (scope, message, detail) => emit(console.error, scope, message, detail),
};

// One sink per realm by design — a host routes diagnostics once, not per subsystem. The only mutable
// module state schema/ holds; `null` restores the console default.
let sink: LogSink = consoleSink;

export function setLogSink(next: LogSink | null): void {
  sink = next ?? consoleSink;
}

// Every seam that turns a caught `unknown` into user- or wire-facing text needs this one narrowing;
// it lives beside the sinks because those are the only consumers that exist.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function logWarn(scope: LogScope, message: string, detail?: unknown): void {
  sink.warn(scope, message, detail);
}

export function logError(scope: LogScope, message: string, detail?: unknown): void {
  sink.error(scope, message, detail);
}

/** A rejection handler for fire-and-forget seams: `void promise.catch(rejectionLogger("boot", "…"))`. */
export function rejectionLogger(scope: LogScope, message: string): (error: unknown) => void {
  return (error) => sink.error(scope, message, error);
}
