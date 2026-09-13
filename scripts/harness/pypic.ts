import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The one way this repo shells out to the sibling pypic checkout. Four call sites had written the
// same uv invocation with the same cwd, encoding, timeout and buffer ceiling; the ceiling and the
// timeout in particular are tuned together (M3.5's MHD goldens are hundreds of MB of JSON), so they
// belong in one place rather than four that happen to agree.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 512 * 1024 * 1024; // headroom for the larger MHD golden fields

export interface PypicRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// Raw result, for a caller that wants to assert on a nonzero status rather than throw on it.
export function spawnPypic(argv: readonly string[], input?: string): PypicRun {
  const result: SpawnSyncReturns<string> = spawnSync(
    "uv",
    ["run", "--project", "../pypic", ...argv],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      ...(input !== undefined ? { input } : {}),
    },
  );
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Run pypic and parse its stdout as JSON, throwing with the child's stderr on a nonzero exit. The
// response shape is the caller's contract with the python script it names, hence the unchecked cast.
export function runPypic<T>(argv: readonly string[], request?: unknown): T {
  const run = spawnPypic(argv, request === undefined ? undefined : JSON.stringify(request));
  if (run.status !== 0) {
    throw new Error(`pypic ${argv.join(" ")} exited ${run.status}:\n${run.stderr}`);
  }
  return JSON.parse(run.stdout) as T;
}
