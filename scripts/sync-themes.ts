// Copies pypic's bundled theme TOMLs into the webpic tree verbatim, so the build is
// self-contained (no sibling-repo path dependency at build/deploy time). Run via
// `npm run gen:themes`; `gen:themes:check` guards drift in CI. pypic owns the format
// and the `[webpic]` block — webpic is a consumer. Copied byte-for-byte so the check
// diffs exactly. Mirrors the schema-codegen pattern in scripts/codegen/.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = resolve(ROOT, "../pypic/src/pypic/plotting/themes");
const DEST_DIR = resolve(ROOT, "src/data/theme/themes");

const sources = readdirSync(SRC_DIR).filter((file) => file.endsWith(".toml"));
if (sources.length === 0) {
  throw new Error(`No theme TOMLs found in ${SRC_DIR} — is pypic checked out?`);
}

rmSync(DEST_DIR, { recursive: true, force: true });
mkdirSync(DEST_DIR, { recursive: true });

for (const file of sources) {
  writeFileSync(resolve(DEST_DIR, basename(file)), readFileSync(resolve(SRC_DIR, file)));
}

console.log(
  `synced ${sources.length} theme(s): ${sources.map((f) => basename(f, ".toml")).join(", ")}`,
);
