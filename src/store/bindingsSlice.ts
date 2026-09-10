import type { ColormapBinding } from "@schema/colormap.ts";
import * as colormapOps from "./colormap.ts";
import type { BindingsSlice, SliceContext } from "./state.ts";

// The ColormapBinding registry — every setter runs a pure op and commits only a real change.

export function createBindingsSlice({ get, set }: SliceContext): BindingsSlice {
  const update = (
    op: (
      bindings: Readonly<Record<string, ColormapBinding>>,
    ) => Readonly<Record<string, ColormapBinding>>,
  ): void => {
    const { colormapBindings } = get();
    const next = op(colormapBindings);
    if (next !== colormapBindings) set({ colormapBindings: next });
  };
  return {
    colormapBindings: {},
    setBindingColormap(id, colormap) {
      update((b) => colormapOps.setBindingColormap(b, id, colormap));
    },
    setBindingWindow(id, center, width) {
      update((b) => colormapOps.setBindingWindow(b, id, center, width));
    },
    setBindingScale(id, scale) {
      update((b) => colormapOps.setBindingScale(b, id, scale));
    },
  };
}
