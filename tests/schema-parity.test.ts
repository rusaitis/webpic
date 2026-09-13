// Schema parity with pypic, the canonical-name authority. Two layers:
//   A. The checked-in generated artifacts must regenerate byte-for-byte from the checked-in
//      bundle (catches hand-edits / a stale `gen:emit`). Offline, always runs.
//   B. pypic's *current* schema must not have removed anything (v1.x is additive-only). Shells
//      out to pypic, so it's opt-in via WEBPIC_PYPIC_PARITY=1 to keep the default suite hermetic.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Bundle, loadBundle } from "../scripts/codegen/bundle.ts";
import { renderAliases } from "../scripts/codegen/render-aliases.ts";
import { renderRecipes } from "../scripts/codegen/render-recipes.ts";
import { renderRegistry } from "../scripts/codegen/render-registry.ts";
import { renderValidators } from "../scripts/codegen/render-schema.ts";
import { type PypicRun, spawnPypic } from "../scripts/harness/pypic.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIOME_BIN = resolve(ROOT, "node_modules/.bin/biome");
const BUNDLE_PATH = resolve(ROOT, "src/schema/pypic-export.generated.json");

// Format a rendered source string exactly as `gen:emit` does (renderer → Biome). The
// `*.generated.ts` Biome override disables only the linter, so the formatter still applies.
function biomeFormat(source: string, relPath: string): string {
  const result = spawnSync(BIOME_BIN, ["format", `--stdin-file-path=${relPath}`], {
    input: source,
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`biome format ${relPath} failed (status ${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

const ARTIFACTS = [
  { render: renderValidators, path: "src/schema/validators.generated.ts" },
  { render: renderAliases, path: "src/schema/aliases.generated.ts" },
  { render: renderRegistry, path: "src/schema/registry.generated.ts" },
  { render: renderRecipes, path: "src/compute/recipes.generated.ts" },
] as const;

describe("regenerated artifacts match checked-in", () => {
  const bundle = loadBundle(BUNDLE_PATH);

  it.each(ARTIFACTS)("$path is freshly emitted from the bundle", ({ render, path }) => {
    const regenerated = biomeFormat(render(bundle), path);
    const checkedIn = readFileSync(resolve(ROOT, path), "utf8");
    expect(regenerated).toBe(checkedIn);
  });
});

const RUN_PYPIC = process.env.WEBPIC_PYPIC_PARITY === "1";

// Raw result, not runPypic: these assertions are about the exit status itself.
const pypic = (args: readonly string[]): PypicRun => spawnPypic(["pypic", ...args]);

// Opt-in: needs uv + the sibling ../pypic repo. Guards against pypic making a *breaking*
// (non-additive) change out from under webpic's checked-in artifacts.
describe.skipIf(!RUN_PYPIC)("additive-compat vs pypic ground truth", () => {
  let checkedIn: Bundle;
  let current: Bundle;

  // Hook/test timeouts sized to the spawnSync budget: concurrent uv invocations (the
  // writer-parity suite shells out too) contend on the project env and can exceed the
  // 5 s vitest default even when each subprocess is healthy.
  beforeAll(() => {
    checkedIn = loadBundle(BUNDLE_PATH);
    // Same flags as `npm run gen:export`, so the jsonSchema is apples-to-apples.
    const out = join(tmpdir(), "webpic-pypic-current-bundle.json");
    const exported = pypic([
      "export",
      "bundle",
      "--inline-single-use-defs",
      "--include-x-extensions",
      "-o",
      out,
    ]);
    if (exported.status !== 0) {
      throw new Error(`pypic export bundle failed (status ${exported.status}): ${exported.stderr}`);
    }
    current = JSON.parse(readFileSync(out, "utf8")) as Bundle;
  }, 120_000);

  // These canonical-name surfaces aren't in the jsonSchema, so the structural diff below
  // wouldn't catch a removal — check them directly.
  const SURFACES = ["fields", "recipes", "computeAliases", "groupAliases"] as const;
  it.each(SURFACES)("keeps every checked-in %s (no removals)", (surface) => {
    const removed = Object.keys(checkedIn[surface]).filter(
      (k) => !Object.hasOwn(current[surface], k),
    );
    expect(removed).toEqual([]);
  });

  it("jsonSchema changes are additive (pypic schema diff: no removals)", {
    timeout: 120_000,
  }, () => {
    const a = join(tmpdir(), "webpic-schema-checked-in.json");
    const b = join(tmpdir(), "webpic-schema-current.json");
    writeFileSync(a, JSON.stringify(checkedIn.jsonSchema));
    writeFileSync(b, JSON.stringify(current.jsonSchema));
    // diff exits 0 (identical) or 1 (differ); 2 / null is a hard error.
    const diff = pypic(["schema", "diff", a, b, "--format", "json"]);
    if (diff.status === null || diff.status >= 2) {
      throw new Error(`pypic schema diff failed (status ${diff.status}): ${diff.stderr}`);
    }
    const structured = JSON.parse(diff.stdout) as {
      added: readonly string[];
      removed: readonly string[];
      changed: Record<string, unknown>;
    };
    expect(structured.removed).toEqual([]);
  });

  it("stays within schema major 1 (no breaking 2.0 bump)", () => {
    expect(current.schemaVersion.split(".")[0]).toBe(checkedIn.schemaVersion.split(".")[0]);
  });
});
