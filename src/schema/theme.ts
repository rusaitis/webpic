// Theme = the single source of visual configuration, shared with pypic via TOML.
// pypic owns the file format and ships the `[webpic]` block in every bundled theme;
// webpic is a consumer. The value model only — dependency-free, so a render-side
// `cssRgba` call cannot drag zod into the worker chunk; ./themeParse.ts reads the TOML.

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
