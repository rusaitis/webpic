import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Repo-tree walking for the node-only meta-guards (boundaries, comment budget, § citations, live
// modules). It does not live in tests/helpers.ts: the real-Chrome browser project imports that file,
// and `node:fs` does not resolve there. Filtering stays at the call sites — each guard wants a
// different subset, and three explicit filters read better than one options bag.

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function typescriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(REPO_ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...typescriptFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}
