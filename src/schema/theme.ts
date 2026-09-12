import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { errorMessage } from "./log.ts";
import { formatZodError } from "./zodError.ts";

// Theme = the single source of visual configuration, shared with pypic via TOML.
// pypic owns the file format and ships the `[webpic]` block in every bundled theme;
// webpic is a consumer. This module is pure (parse + validate + normalize) so it
// lives in `schema` (the root layer) and is reachable by render, store, ui, and app.

// Colors arrive as `#rrggbb`/`#rgb` strings or `[r,g,b]`/`[r,g,b,a]` float arrays
// (0..1); we normalize everything to RGBA-0..1, mirroring pypic's `_parse_rgba`.
export type Rgba01 = readonly [number, number, number, number];

export interface ThemeColors {
  readonly background: Rgba01 | undefined;
  readonly accent: Rgba01 | undefined;
  readonly text: Rgba01 | undefined;
  readonly secondaryText: Rgba01 | undefined;
  readonly grid: Rgba01 | undefined;
  readonly cycle: readonly string[]; // qualitative cycle, kept as source hex strings
}

export interface ThemeFont {
  readonly family: readonly string[];
  readonly title: number | undefined;
  readonly label: number | undefined;
  readonly tick: number | undefined;
  readonly overlay: number | undefined;
}

export interface ThemeAxes {
  readonly x: Rgba01 | undefined;
  readonly y: Rgba01 | undefined;
  readonly z: Rgba01 | undefined;
  readonly arrows: boolean;
}

export interface WebpicThemeConfig {
  readonly version: number;
  readonly layout: {
    readonly defaultPanels: readonly string[];
    readonly dockedSide: "left" | "right";
    readonly panelCollapsedDefault: boolean;
  };
  readonly shortcuts: {
    readonly toggleVolume: string;
    readonly toggleSlices: string;
    readonly toggleUi: string;
    readonly commandPalette: string;
  };
  readonly diagnostics: {
    readonly fpsOverlay: boolean;
    readonly gpuMemoryOverlay: boolean;
    readonly timestampQueryOverlay: boolean;
  };
  readonly embed: {
    readonly bannerOnCorsFailure: boolean;
    readonly defaultControlsVisible: boolean;
  };
}

export interface Theme {
  readonly name: string;
  readonly colors: ThemeColors;
  readonly colormaps: { readonly sequential: string; readonly diverging: string };
  readonly font: ThemeFont;
  readonly axes: ThemeAxes;
  readonly webpic: WebpicThemeConfig;
}

// Used verbatim when a theme omits `[webpic]` (DESIGN: fall back silently). `defaultPanels` is
// webpic's own fallback and may lead the vendored pypic theme TOMLs (synced via scripts/sync-themes)
// until pypic's `[webpic.layout]` blocks pick them up.
export const DEFAULT_WEBPIC_CONFIG: WebpicThemeConfig = {
  version: 1,
  layout: {
    // dataset/field/time live in the top menu bar (ui/topbar/bar); axes & grid in the left rail flyout
    // (ui/layers/toolRail); color mapping in the floating colorbar (ui/colorbar); the Developer tool in a
    // floating window (ui/panels/devWindow). The docked shell is empty by default — reserved for
    // future docked panels (the shell isn't rendered when this is empty).
    defaultPanels: [],
    dockedSide: "right",
    panelCollapsedDefault: false,
  },
  shortcuts: { toggleVolume: "V", toggleSlices: "S", toggleUi: "F", commandPalette: "Cmd+K" },
  diagnostics: { fpsOverlay: false, gpuMemoryOverlay: false, timestampQueryOverlay: false },
  embed: { bannerOnCorsFailure: true, defaultControlsVisible: true },
};

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

export function cssRgba(color: Rgba01): string {
  const [r, g, b, a] = color;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

// Canonical axis-triad palette (X red, Y green, Z blue): the corner gnomon's HUD colors and the
// fallback for the in-scene 3D axes when a theme omits axis colors. One source so the HUD gnomon
// (ui/theme/styles) and the render overlay (app/sceneBridge) can't drift apart.
export const FALLBACK_AXIS: { readonly x: Rgba01; readonly y: Rgba01; readonly z: Rgba01 } = {
  x: [0.878, 0.424, 0.459, 1], // #e06c75
  y: [0.596, 0.765, 0.475, 1], // #98c379
  z: [0.38, 0.686, 0.937, 1], // #61afef
};

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
