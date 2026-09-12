import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `§Name` cites in code must name a real heading: a line-number pin (`§443`) rots the moment the
// doc moves, and a renamed section leaves a cite pointing nowhere. Generated files are exempt —
// their docstrings come from pypic and cite pypic's own numbered schema.md.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SOURCE_DIRS = ["src", "scripts"];
const DOCS = { "docs/DESIGN.md": "DESIGN", "CLAUDE.md": "CLAUDE.md" } as const;

interface Citation {
  readonly file: string;
  readonly line: number;
  readonly raw: string;
  readonly target: keyof typeof DOCS;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`"*]/g, "")
    .replace(/’/g, "'")
    .replace(/\s+/g, " ")
    .replace(/['’]s$/, "")
    .replace(/^[\s\-—:]+|[\s\-—:.]+$/g, "");
}

function headings(file: string): Set<string> {
  const found = new Set<string>();
  for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
    const match = line.match(/^#{2,4}\s+(.+)$/);
    if (match?.[1] !== undefined) found.add(normalize(match[1]));
  }
  return found;
}

// A cite ends at the first delimiter that cannot appear in a heading; a quoted cite
// (`§"Layers & navigation"`) carries its own delimiters, so commas inside it are safe.
function citeText(rest: string): string {
  if (rest.startsWith('"')) return rest.slice(1).split('"', 1)[0] ?? "";
  return (rest.split(/[,)\]};:`"]|\.\s|\.$| — /, 1)[0] ?? "").trim();
}

// Cites abbreviate ("§UI" for "## UI", "§Time-series" for "### Time-series playback"), so a cite
// resolves when it equals a heading or is a word-boundary prefix of one.
function resolves(cite: string, known: ReadonlySet<string>): boolean {
  const words = normalize(cite).split(" ");
  for (let count = words.length; count > 0; count--) {
    const candidate = normalize(words.slice(0, count).join(" "));
    if (candidate === "") continue;
    if (known.has(candidate)) return true;
    for (const heading of known) {
      if (heading === candidate || heading.startsWith(`${candidate} `)) return true;
    }
  }
  return false;
}

function citations(files: readonly string[]): Citation[] {
  const found: Citation[] = [];
  for (const file of files) {
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      // Every `§` on the line, not just the first — and `§` followed by whitespace is the symbol
      // used as a word ("a § that isn't a heading"), not a cite.
      for (const match of line.matchAll(/§/g)) {
        const rest = line.slice(match.index + 1);
        if (rest === "" || /^\s/.test(rest)) continue;
        const raw = citeText(rest);
        if (raw === "") continue;
        const before = line.slice(0, match.index);
        found.push({
          file,
          line: index + 1,
          raw,
          target: /CLAUDE\.md\s*$/.test(before) ? "CLAUDE.md" : "docs/DESIGN.md",
        });
      }
    });
  }
  return found;
}

function sourceFiles(): string[] {
  const found = SOURCE_DIRS.flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") && !name.includes(".generated."))
      .map((name) => join(dir, name)),
  );
  return [...found, "CLAUDE.md"];
}

describe("docs/DESIGN.md section citations", () => {
  const known = {
    "docs/DESIGN.md": headings("docs/DESIGN.md"),
    "CLAUDE.md": headings("CLAUDE.md"),
  };
  const files = sourceFiles();
  const cites = citations(files);

  it("finds the cites it is meant to guard", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(cites.length).toBeGreaterThan(30);
  });

  it("resolves every cite to a heading in the document it names", () => {
    const dangling = cites
      .filter((cite) => !resolves(cite.raw, known[cite.target]))
      .map((cite) => `${cite.file}:${cite.line} → ${DOCS[cite.target]} §${cite.raw}`);
    expect(dangling).toEqual([]);
  });

  it("never pins a line number", () => {
    const numeric = cites
      .filter((cite) => /^\d/.test(cite.raw))
      .map((cite) => `${cite.file}:${cite.line} → §${cite.raw}`);
    expect(numeric).toEqual([]);
  });
});
