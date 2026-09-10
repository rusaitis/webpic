// The one diagnostics seam every layer can reach (schema is the DAG root): warnings and errors on
// genuine failure paths route here instead of raw console calls, so an embedding host can redirect
// or silence webpic once via setLogSink. Not a general logger — hot paths and debug output stay out.

export interface LogSink {
  readonly warn: (scope: string, message: string, detail?: unknown) => void;
  readonly error: (scope: string, message: string, detail?: unknown) => void;
}

function emit(
  write: (...args: readonly unknown[]) => void,
  scope: string,
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

export function logWarn(scope: string, message: string, detail?: unknown): void {
  sink.warn(scope, message, detail);
}

export function logError(scope: string, message: string, detail?: unknown): void {
  sink.error(scope, message, detail);
}

/** A rejection handler for fire-and-forget seams: `void promise.catch(rejectionLogger("boot", "…"))`. */
export function rejectionLogger(scope: string, message: string): (error: unknown) => void {
  return (error) => sink.error(scope, message, error);
}
