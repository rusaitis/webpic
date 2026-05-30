import { BANNER, type Bundle } from "./bundle.ts";

function record(obj: Record<string, string>): string {
  const entries = Object.entries(obj)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n");
  return `{\n${entries}\n}`;
}

export function renderAliases(bundle: Bundle): string {
  // Python named groups `(?P<x>)` are invalid in JS regex — rewrite to `(?<x>)`.
  const jsPattern = bundle.speciesSuffixRe.replaceAll("(?P<", "(?<");
  new RegExp(jsPattern); // fail fast if the translation produced an invalid pattern

  return (
    `${BANNER}` +
    `export const COMPUTE_ALIASES: Record<string, string> = ${record(bundle.computeAliases)};\n\n` +
    `export const GROUP_ALIASES: Record<string, string> = ${record(bundle.groupAliases)};\n\n` +
    `export const SPECIES_SUFFIX_RE = new RegExp(${JSON.stringify(jsPattern)});\n`
  );
}
