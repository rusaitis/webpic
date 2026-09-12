import type { ColormapBinding } from "@schema/colormap.ts";

// Slot resolution for the colorbar stack: at most MAX_COLORBARS strips ("max two for sanity" —
// DESIGN §UI), filled from the visible bindings in draw order. The selected layer's binding is
// guaranteed a slot so the gear always edits a strip that's on screen; everything else overflows
// into the soft-warn badge. Pure — the colorbar DOM consumes the layout verbatim.

export const MAX_COLORBARS = 2;

export interface ColorbarStack {
  // The bindings that get a strip, ≤ MAX_COLORBARS, in draw order.
  readonly slots: readonly ColormapBinding[];
  // Distinct visible bindings without a strip — the soft-warn's content.
  readonly overflow: readonly ColormapBinding[];
}

export function colorbarStack(
  visible: readonly ColormapBinding[],
  activeBindingId: string | null,
): ColorbarStack {
  if (visible.length <= MAX_COLORBARS) return { slots: visible, overflow: [] };
  const slots = visible.slice(0, MAX_COLORBARS);
  if (activeBindingId !== null && !slots.some((b) => b.id === activeBindingId)) {
    const active = visible.find((b) => b.id === activeBindingId);
    if (active !== undefined) slots[MAX_COLORBARS - 1] = active;
  }
  return { slots, overflow: visible.filter((b) => !slots.includes(b)) };
}
