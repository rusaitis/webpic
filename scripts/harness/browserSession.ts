import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";
import { build, type LogLevel, type PreviewServer, preview } from "vite";

// One production build, served by `vite preview` (so COOP/COEP and the worker chunking match prod),
// driven by the *installed* Chrome stable on a throwaway profile — headed, because headless WebGPU
// on macOS/Metal is unreliable (DESIGN §CI). Teardown (browser, server, profile dir) runs even when
// the callback throws; the throw is re-raised afterwards.

export interface PreviewedApp {
  /** A fresh tab on the throwaway profile; `context.newPage()` for more. */
  readonly page: Page;
  readonly context: BrowserContext;
  /** `http://localhost:<port>/` — append `?n=256`, `?pose=…` and navigate. */
  readonly baseUrl: string;
  readonly server: PreviewServer;
}

export interface PreviewedAppOptions {
  /** Preview whatever is already in dist/ instead of rebuilding. */
  readonly skipBuild?: boolean;
  readonly buildLogLevel?: LogLevel;
  /** Appended after the base Chrome flags, e.g. `--window-size=1440,900`. */
  readonly chromeArgs?: readonly string[];
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor?: number;
}

const CHROME_ARGS = ["--no-first-run", "--no-default-browser-check"] as const;

export async function withPreviewedApp<T>(
  fn: (app: PreviewedApp) => Promise<T>,
  options: PreviewedAppOptions = {},
): Promise<T> {
  if (!options.skipBuild) await build({ logLevel: options.buildLogLevel ?? "warn" });
  const server = await preview({ preview: { port: 0 } });
  try {
    const baseUrl = server.resolvedUrls?.local?.[0];
    if (baseUrl === undefined) throw new Error("vite preview did not resolve a local URL");
    const profileDir = await mkdtemp(join(tmpdir(), "webpic-profile-"));
    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        channel: "chrome", // the installed Chrome stable, not Playwright's bundled Chromium
        headless: false,
        args: [...CHROME_ARGS, ...(options.chromeArgs ?? [])],
        ...(options.viewport !== undefined && { viewport: options.viewport }),
        ...(options.deviceScaleFactor !== undefined && {
          deviceScaleFactor: options.deviceScaleFactor,
        }),
      });
      try {
        const page = await context.newPage();
        return await fn({ page, context, baseUrl, server });
      } finally {
        await context.close();
      }
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  } finally {
    await server.close();
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
