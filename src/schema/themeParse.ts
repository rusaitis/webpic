// TOML parse + validation for the theme model. Split from ./theme.ts because that module is
// value-imported by the render worker (`cssRgba`), and zod + smol-toml here would ride into the
// worker chunk behind it. Validate at boundaries only (CLAUDE.md §Schema, validation, boundaries).
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { errorMessage } from "./log.ts";
import { DEFAULT_WEBPIC_CONFIG, type Rgba01, type Theme, type WebpicThemeConfig } from "./theme.ts";
import { formatZodError } from "./zodError.ts";

const HEX_RE = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i;

function hexToRgba01(hex: string): Rgba01 {
  const body = hex.slice(1);
  const full =
    body.length === 3 ? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}` : body;
  return [
    Number.parseInt(full.slice(0, 2), 16) / 255,
    Number.parseInt(full.slice(2, 4), 16) / 255,
    Number.parseInt(full.slice(4, 6), 16) / 255,
    1,
  ];
}

const ColorSchema = z
  .union([
    z.string().regex(HEX_RE, "expected #rgb or #rrggbb hex color"),
    z.tuple([z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
  ])
  .transform((value): Rgba01 => {
    if (typeof value === "string") return hexToRgba01(value);
    return value.length === 3 ? [value[0], value[1], value[2], 1] : value;
  });

// pypic stores colormap preference as a single name or a fallback list; we take the
// first (highest-preference) name. Matplotlib-name resolution to a LUT is future work.
const ColormapName = z
  .union([z.string(), z.array(z.string()).nonempty()])
  .transform((value) => (typeof value === "string" ? value : value[0]));

const FontFamily = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (typeof value === "string" ? [value] : value));

// Non-strict objects: unknown keys (pypic's matplotlib-only sections like [lines],
// [grid], and extra [colors.*] entries) are stripped, not rejected.
const RawWebpic = z
  .object({
    version: z.number().optional(),
    layout: z
      .object({
        "default-panels": z.array(z.string()).optional(),
        "docked-side": z.enum(["left", "right"]).optional(),
        "panel-collapsed-default": z.boolean().optional(),
      })
      .optional(),
    shortcuts: z
      .object({
        "toggle-volume": z.string().optional(),
        "toggle-slices": z.string().optional(),
        "toggle-ui": z.string().optional(),
        "command-palette": z.string().optional(),
      })
      .optional(),
    diagnostics: z
      .object({
        "fps-overlay": z.boolean().optional(),
        "gpu-memory-overlay": z.boolean().optional(),
        "timestamp-query-overlay": z.boolean().optional(),
      })
      .optional(),
    embed: z
      .object({
        "banner-on-cors-failure": z.boolean().optional(),
        "default-controls-visible": z.boolean().optional(),
      })
      .optional(),
  })
  .optional();

function resolveWebpic(raw: z.infer<typeof RawWebpic>): WebpicThemeConfig {
  const d = DEFAULT_WEBPIC_CONFIG;
  return {
    version: raw?.version ?? d.version,
    layout: {
      defaultPanels: raw?.layout?.["default-panels"] ?? d.layout.defaultPanels,
      dockedSide: raw?.layout?.["docked-side"] ?? d.layout.dockedSide,
      panelCollapsedDefault:
        raw?.layout?.["panel-collapsed-default"] ?? d.layout.panelCollapsedDefault,
    },
    shortcuts: {
      toggleVolume: raw?.shortcuts?.["toggle-volume"] ?? d.shortcuts.toggleVolume,
      toggleSlices: raw?.shortcuts?.["toggle-slices"] ?? d.shortcuts.toggleSlices,
      toggleUi: raw?.shortcuts?.["toggle-ui"] ?? d.shortcuts.toggleUi,
      commandPalette: raw?.shortcuts?.["command-palette"] ?? d.shortcuts.commandPalette,
    },
    diagnostics: {
      fpsOverlay: raw?.diagnostics?.["fps-overlay"] ?? d.diagnostics.fpsOverlay,
      gpuMemoryOverlay: raw?.diagnostics?.["gpu-memory-overlay"] ?? d.diagnostics.gpuMemoryOverlay,
      timestampQueryOverlay:
        raw?.diagnostics?.["timestamp-query-overlay"] ?? d.diagnostics.timestampQueryOverlay,
    },
    embed: {
      bannerOnCorsFailure: raw?.embed?.["banner-on-cors-failure"] ?? d.embed.bannerOnCorsFailure,
      defaultControlsVisible:
        raw?.embed?.["default-controls-visible"] ?? d.embed.defaultControlsVisible,
    },
  };
}

const ThemeFileSchema = z
  .object({
    name: z.string().optional(),
    colors: z
      .object({
        background: ColorSchema.optional(),
        accent: ColorSchema.optional(),
        text: ColorSchema.optional(),
        secondary_text: ColorSchema.optional(),
        grid: ColorSchema.optional(),
        cycle: z.object({ values: z.array(z.string()).optional() }).optional(),
      })
      .optional(),
    colormaps: z
      .object({ sequential: ColormapName.optional(), diverging: ColormapName.optional() })
      .optional(),
    font: z
      .object({
        family: FontFamily.optional(),
        title: z.number().optional(),
        label: z.number().optional(),
        tick: z.number().optional(),
        overlay: z.number().optional(),
      })
      .optional(),
    axes: z
      .object({
        x_color: ColorSchema.optional(),
        y_color: ColorSchema.optional(),
        z_color: ColorSchema.optional(),
        arrows: z.boolean().optional(),
      })
      .optional(),
    webpic: RawWebpic,
  })
  .transform((raw) => ({ raw }));

// Reusable colormap fallbacks; pypic's own defaults if a theme omits the section.
const DEFAULT_SEQUENTIAL = "inferno";
const DEFAULT_DIVERGING = "RdBu_r";

/**
 * Parse + validate a theme TOML into a normalized {@link Theme}. Pure (no I/O) — the
 * entry point for both bundled themes and user-supplied custom themes. Throws
 * `parseTheme: invalid theme in "<sourceName>" — …` for malformed TOML and for a structurally
 * invalid one alike; a missing `[webpic]` block is not invalid — it yields
 * {@link DEFAULT_WEBPIC_CONFIG}.
 */
export function parseTheme(tomlText: string, sourceName?: string): Theme {
  const where = sourceName ? ` in "${sourceName}"` : "";
  let document: unknown;
  try {
    document = parseToml(tomlText);
  } catch (error) {
    // smol-toml's own SyntaxError names neither the theme nor this function — a user-supplied theme
    // has to fail the same way whether it is malformed TOML or a wrong-typed key.
    throw new Error(`parseTheme: invalid theme${where} — ${errorMessage(error)}`);
  }
  const parsed = ThemeFileSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`parseTheme: invalid theme${where} — ${formatZodError(parsed.error)}`);
  }
  const { raw } = parsed.data;
  return {
    name: raw.name ?? sourceName ?? "unnamed",
    colors: {
      background: raw.colors?.background,
      accent: raw.colors?.accent,
      text: raw.colors?.text,
      secondaryText: raw.colors?.secondary_text,
      grid: raw.colors?.grid,
      cycle: raw.colors?.cycle?.values ?? [],
    },
    colormaps: {
      sequential: raw.colormaps?.sequential ?? DEFAULT_SEQUENTIAL,
      diverging: raw.colormaps?.diverging ?? DEFAULT_DIVERGING,
    },
    font: {
      family: raw.font?.family ?? [],
      title: raw.font?.title,
      label: raw.font?.label,
      tick: raw.font?.tick,
      overlay: raw.font?.overlay,
    },
    axes: {
      x: raw.axes?.x_color,
      y: raw.axes?.y_color,
      z: raw.axes?.z_color,
      arrows: raw.axes?.arrows ?? true,
    },
    webpic: resolveWebpic(raw.webpic),
  };
}
