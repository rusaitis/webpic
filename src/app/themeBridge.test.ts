import { parseTheme, type Theme } from "@schema";
import { createUiStore } from "@store";
import { describe, expect, it } from "vitest";
import { installThemeBridge } from "./themeBridge.ts";

function makeTheme(name: string): Theme {
  return parseTheme(`name = "${name}"`, name);
}

function harness(names: readonly string[], initialName: string) {
  const themes = new Map(names.map((name) => [name, makeTheme(name)]));
  const uiStore = createUiStore();
  const applied: string[] = [];
  const persisted: string[] = [];
  const bridge = installThemeBridge({
    uiStore,
    themes,
    initialName,
    applyTheme: (theme) => applied.push(theme.name),
    persist: async (name) => {
      persisted.push(name);
    },
  });
  return { uiStore, applied, persisted, bridge };
}

describe("installThemeBridge", () => {
  it("seeds the boot theme through the apply + persist path", () => {
    const { uiStore, applied, persisted } = harness(["dark", "light"], "dark");
    expect(uiStore.getState().themeName).toBe("dark");
    expect(applied).toEqual(["dark"]);
    expect(persisted).toEqual(["dark"]);
  });

  it("cycles through the catalog in insertion order and wraps", () => {
    const { uiStore, applied } = harness(["dark", "light", "lcars"], "dark");
    uiStore.getState().requestThemeCycle();
    uiStore.getState().requestThemeCycle();
    uiStore.getState().requestThemeCycle(); // wraps back to the first
    expect(applied).toEqual(["dark", "light", "lcars", "dark"]);
    expect(uiStore.getState().themeName).toBe("dark");
  });

  it("ignores a foreign theme name without applying", () => {
    const { uiStore, applied } = harness(["dark", "light"], "dark");
    uiStore.getState().setThemeName("not-a-theme");
    expect(applied).toEqual(["dark"]); // unchanged — stale pref names must not blank the UI
    uiStore.getState().requestThemeCycle(); // a foreign current restarts the cycle at the first
    expect(uiStore.getState().themeName).toBe("dark");
  });

  it("identity-skips a repeated name (no re-apply, no re-persist)", () => {
    const { uiStore, applied, persisted } = harness(["dark", "light"], "dark");
    uiStore.getState().setThemeName("dark");
    expect(applied).toEqual(["dark"]);
    expect(persisted).toEqual(["dark"]);
  });

  it("stops reacting after dispose", () => {
    const { uiStore, applied, bridge } = harness(["dark", "light"], "dark");
    bridge();
    uiStore.getState().requestThemeCycle();
    expect(applied).toEqual(["dark"]);
  });
});
