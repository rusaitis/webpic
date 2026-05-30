import { BANNER, type Bundle } from "./bundle.ts";

export function renderRegistry(bundle: Bundle): string {
  const entries = Object.entries(bundle.fields)
    .map(([name, info]) => `  ${JSON.stringify(name)}: ${JSON.stringify(info)},`)
    .join("\n");

  return (
    `${BANNER}` +
    `import type { FieldMeta } from "./types.ts";\n\n` +
    `export const FIELD_REGISTRY: Record<string, FieldMeta> = {\n${entries}\n};\n`
  );
}
