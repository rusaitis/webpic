import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Project, type SourceFile } from "ts-morph";
import { canImport, LAYERS, type LayerName } from "./layers.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAYER_SET: ReadonlySet<string> = new Set(LAYERS);

export interface ImportEdge {
  readonly fromFile: string;
  readonly fromLayer: LayerName;
  readonly toLayer: LayerName;
  readonly specifier: string;
}

// `…/src/<layer>/…` → `<layer>`. Files not inside a layer dir (e.g. src/main.ts) → undefined.
export function layerOfPath(filePath: string): LayerName | undefined {
  const match = filePath.replace(/\\/g, "/").match(/\/src\/([^/]+)(?:\/|$)/);
  const layer = match?.[1];
  // LAYER_SET.has narrows membership but not the string type, hence the assertion.
  return layer !== undefined && LAYER_SET.has(layer) ? (layer as LayerName) : undefined;
}

export function specifierToLayer(specifier: string, fromFile: string): LayerName | undefined {
  if (specifier.startsWith("@")) {
    const name = specifier.slice(1).split("/", 1)[0];
    return name !== undefined && LAYER_SET.has(name) ? (name as LayerName) : undefined;
  }
  if (specifier.startsWith(".")) {
    return layerOfPath(resolve(dirname(fromFile), specifier));
  }
  return undefined; // bare/node: specifiers are external, not layer-scoped
}

// Every module specifier reachable from a file: static imports, `import type`, dynamic
// `import()` (all via getImportStringLiterals), plus `export … from`.
function moduleSpecifiers(sourceFile: SourceFile): string[] {
  const specifiers = sourceFile.getImportStringLiterals().map((lit) => lit.getLiteralValue());
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const value = exportDecl.getModuleSpecifierValue();
    if (value !== undefined) specifiers.push(value);
  }
  return specifiers;
}

export function gatherEdges(project: Project): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    const fromFile = sourceFile.getFilePath();
    const fromLayer = layerOfPath(fromFile);
    if (fromLayer === undefined) continue;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const toLayer = specifierToLayer(specifier, fromFile);
      if (toLayer === undefined || toLayer === fromLayer) continue;
      edges.push({ fromFile, fromLayer, toLayer, specifier });
    }
  }
  return edges;
}

export function findViolations(edges: readonly ImportEdge[]): ImportEdge[] {
  return edges.filter((edge) => !canImport(edge.fromLayer, edge.toLayer));
}

function main(): void {
  const project = new Project({ tsConfigFilePath: resolve(ROOT, "tsconfig.json") });
  const edges = gatherEdges(project);
  const violations = findViolations(edges);
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(
        `✖ ${relative(ROOT, v.fromFile)} [${v.fromLayer}] → @${v.toLayer}  (${v.specifier})`,
      );
    }
    console.error(`\n${violations.length} layer-boundary violation(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ boundaries clean: ${edges.length} cross-layer import(s) checked.`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
