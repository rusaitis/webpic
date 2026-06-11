import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";
import { layerAliases } from "./scripts/aliases.ts";

const alias = layerAliases(import.meta.dirname);

// Real-GPU suites (`*.browser.test.ts`) run in headed system Chrome via `npm run test:gpu`.
// Env-gated so plain `vitest`/CI never pops a browser window or requires Chrome to exist.
const gpuProject = {
  resolve: { alias },
  test: {
    name: "gpu",
    include: ["src/**/*.browser.test.ts"],
    setupFiles: ["tests/setup.gpu.ts"],
    testTimeout: 20_000, // first-run WebGPU pipeline compiles are slow
    browser: {
      enabled: true,
      headless: false, // WebGPU on macOS/Metal is unreliable headless (same as scripts/verify-*)
      provider: playwright({
        launchOptions: {
          channel: "chrome",
          args: ["--no-first-run", "--no-default-browser-check"],
        },
      }),
      instances: [{ browser: "chromium" as const }],
    },
  },
};

// Three projects: the default `node` env for the pure math/store/app tests, a `happy-dom` env
// for the `ui` facade smoke tests (DOM construction can't run in node), and the env-gated `gpu`
// browser project above. `.dom.test.ts` → happy-dom, `.browser.test.ts` → gpu, the rest → node.
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
          exclude: [...configDefaults.exclude, "**/*.dom.test.ts", "**/*.browser.test.ts"],
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
      ...(process.env.WEBPIC_GPU === "1" ? [gpuProject] : []),
    ],
  },
});
