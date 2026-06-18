import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// The PWA manifest + icons are static assets with no build step, so a typo or a renamed icon would
// only surface as a broken install on a device. Guard it here: valid shape (Zod, the repo's
// boundary-validation pattern), the install essentials, and every referenced local icon on disk.

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

const ManifestSchema = z.object({
  name: z.string().min(1),
  short_name: z.string().min(1),
  display: z.string(),
  start_url: z.string(),
  background_color: z.string(),
  theme_color: z.string(),
  icons: z
    .array(
      z.object({
        src: z.string(),
        sizes: z.string(),
        type: z.string(),
        purpose: z.string().optional(),
      }),
    )
    .min(1),
});

const manifest = ManifestSchema.parse(
  JSON.parse(readFileSync(`${publicDir}manifest.webmanifest`, "utf8")),
);

describe("PWA manifest", () => {
  it("declares the install essentials", () => {
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    // theme_color tints the system bars; the index.html <meta name="theme-color"> must agree.
    expect(manifest.theme_color).toBe("#101820");
    expect(manifest.background_color).toBe(manifest.theme_color); // seamless launch splash
  });

  it("ships a 192 + 512 maskable PNG and every icon resolves on disk", () => {
    const pngSizes = new Set(
      manifest.icons.filter((icon) => icon.type === "image/png").map((icon) => icon.sizes),
    );
    expect(pngSizes.has("192x192")).toBe(true);
    expect(pngSizes.has("512x512")).toBe(true);
    const maskable = manifest.icons.filter((icon) =>
      (icon.purpose ?? "").split(" ").includes("maskable"),
    );
    expect(maskable.length).toBeGreaterThan(0); // Android adaptive-icon crop needs one
    for (const icon of manifest.icons) {
      expect(existsSync(`${publicDir}${icon.src.replace(/^\//, "")}`)).toBe(true);
    }
  });
});
