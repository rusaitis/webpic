import { configDefaults, defineConfig } from "vitest/config";
import { layerAliases } from "./scripts/aliases.ts";

const alias = layerAliases(import.meta.dirname);

// Two projects: the default `node` env for the pure math/store/app tests, and a
// `happy-dom` env for the `ui` facade smoke tests (DOM construction can't run in node).
// `.dom.test.ts` files route to happy-dom; everything else stays node-only.
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "node",
          environment: "node",
          globals: false,
          include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.dom.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "dom",
          environment: "happy-dom",
          globals: false,
          include: ["src/**/*.dom.test.ts"],
        },
      },
    ],
  },
});
