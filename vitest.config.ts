import { defineConfig } from "vitest/config";
import { layerAliases } from "./scripts/aliases.ts";

export default defineConfig({
  resolve: {
    alias: layerAliases(import.meta.dirname),
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
