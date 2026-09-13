import { afterEach, describe, expect, it, vi } from "vitest";
import { requireWebGpu, showBlockingBanner } from "./blockingBanner.ts";

const banner = () => document.getElementById("webpic-blocking-banner");

afterEach(() => {
  banner()?.remove();
  document.getElementById("splash")?.remove();
  vi.unstubAllGlobals();
});

describe("showBlockingBanner", () => {
  it("renders the message, the optional detail, and an opt-in reload button", () => {
    showBlockingBanner("dead", { detail: "why", shouldOfferReload: true });
    const element = banner();
    expect(element).not.toBeNull();
    expect(element?.getAttribute("role")).toBe("alert"); // announced, not just painted
    expect(element?.textContent).toContain("dead");
    expect(element?.textContent).toContain("why");
    expect(element?.querySelector("button")).not.toBeNull();
  });

  it("omits the reload button by default — reloading cannot fix an unsupported browser", () => {
    showBlockingBanner("unsupported");
    expect(banner()?.querySelector("button")).toBeNull();
  });

  it("is idempotent: a second fault does not stack banners", () => {
    showBlockingBanner("first");
    showBlockingBanner("second");
    expect(document.querySelectorAll("#webpic-blocking-banner")).toHaveLength(1);
    expect(banner()?.textContent).toContain("first");
  });

  it("clears the boot splash, which must not spin behind a dead view", () => {
    const splash = document.createElement("p");
    splash.id = "splash";
    document.body.append(splash);
    showBlockingBanner("dead");
    expect(document.getElementById("splash")).toBeNull();
  });
});

describe("requireWebGpu", () => {
  it("passes through when navigator.gpu is present", () => {
    vi.stubGlobal("navigator", { gpu: {} });
    expect(requireWebGpu()).toBe(true);
    expect(banner()).toBeNull();
  });

  it("banners and blocks when navigator.gpu is absent", () => {
    vi.stubGlobal("navigator", {});
    expect(requireWebGpu()).toBe(false);
    expect(banner()?.textContent).toContain("WebGPU");
  });

  // A property that exists but reads undefined: `"gpu" in navigator` would call this supported.
  it("banners when navigator.gpu is defined but undefined-valued", () => {
    vi.stubGlobal("navigator", { gpu: undefined });
    expect(requireWebGpu()).toBe(false);
    expect(banner()).not.toBeNull();
  });
});
