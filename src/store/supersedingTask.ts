// A task whose every call supersedes the one before it: the prior run's signal aborts (stopping its
// in-flight work) and its pending commit is discarded, so only the newest call's result lands — the
// pull-based invalidation counter (DESIGN §Compute dispatcher) in its v0.1 shape. The body checks
// `isCurrent()` after every await and returns silently when it is false; supersession never rejects.

export interface TaskRun {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export function createSupersedingTask<TArgs extends readonly unknown[]>(
  body: (run: TaskRun, ...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  let generation = 0;
  let inFlight: AbortController | null = null;
  return (...args) => {
    const current = ++generation;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    return body({ signal: controller.signal, isCurrent: () => current === generation }, ...args);
  };
}
