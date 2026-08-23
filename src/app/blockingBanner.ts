// A full-screen terminal banner replacing a view that can no longer render — a dead GPU device or
// a browser without WebGPU at all. Styled with literals rather than the theme tokens because it
// must paint when the render worker (and possibly the whole UI install) never came up. Idempotent;
// skipped headless (no DOM).
const BANNER_ID = "webpic-blocking-banner";

export interface BlockingBannerOptions {
  /** Adds a Reload button — worth offering for a transient fault, not for an unsupported browser. */
  readonly reload?: boolean;
  /** Rendered under the message in a dimmer weight. */
  readonly detail?: string;
}

export function showBlockingBanner(message: string, options: BlockingBannerOptions = {}): void {
  if (typeof document === "undefined" || document.getElementById(BANNER_ID) !== null) return;
  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.setAttribute("role", "alert");
  banner.style.cssText =
    "position:fixed;inset:0;z-index:1000;display:grid;place-items:center;align-content:center;gap:1rem;padding:2rem;text-align:center;background:rgba(16,24,32,0.94);color:#e8eef4;font:500 14px/1.5 system-ui,sans-serif;";
  const text = document.createElement("p");
  text.style.cssText = "margin:0;max-width:40rem;";
  text.textContent = message;
  banner.append(text);
  if (options.detail !== undefined) {
    const detail = document.createElement("p");
    detail.style.cssText = "margin:0;max-width:40rem;color:#8a94a0;font-size:13px;";
    detail.textContent = options.detail;
    banner.append(detail);
  }
  if (options.reload === true) {
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload";
    reload.style.cssText =
      "padding:0.5rem 1.25rem;font:inherit;cursor:pointer;border-radius:6px;border:1px solid #4a5a6a;background:#1c2a38;color:inherit;";
    reload.addEventListener("click", () => location.reload());
    banner.append(reload);
  }
  document.body.appendChild(banner);
  document.getElementById("splash")?.remove(); // the boot spinner must not outlive the view
}

// Pre-boot guard: no `navigator.gpu` means no adapter request can ever succeed, so say so before
// spawning workers. Tests the value rather than the key — a browser can expose the property as
// undefined (or a policy can neuter it), and `"gpu" in navigator` would still read as supported.
// Returns whether the app may continue.
export function requireWebGpu(): boolean {
  if (typeof navigator !== "undefined" && navigator.gpu !== undefined) return true;
  showBlockingBanner("webpic needs WebGPU, which this browser does not expose.", {
    detail:
      "Supported: Chrome/Edge 113+, Safari 18+, Firefox 141+. In Safari and older Firefox, WebGPU may need to be enabled in settings.",
  });
  return false;
}
