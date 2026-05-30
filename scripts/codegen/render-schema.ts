import { jsonSchemaToZod } from "json-schema-to-zod";
import { BANNER, type Bundle } from "./bundle.ts";

// json-schema-to-zod 2.x emits Zod-v4-targeted TypeScript (z.core.$ZodIssue,
// discriminatedUnion, .catchall). Types flow from z.infer — no separate
// json-schema-to-typescript pass.
export function renderValidators(bundle: Bundle): string {
  // bundle.jsonSchema is typed `unknown`; the lib owns the precise JsonSchema input type.
  const schema = bundle.jsonSchema as Parameters<typeof jsonSchemaToZod>[0];
  const code = jsonSchemaToZod(schema, {
    module: "esm",
    name: "SimulationSchema",
    type: "SimulationConfig",
  });
  return `${BANNER}${code}\n`;
}
