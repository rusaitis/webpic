import { vec3 } from "@schema/math.ts";
import type { PickerSlice, SliceContext } from "./state.ts";

// The point-picker marker: one-shot pick requests plus the marker's position and hover/drag state.

export function createPickerSlice({ get, set }: SliceContext): PickerSlice {
  return {
    pickRequest: null,
    pickerPoint: [0, 0, 0],
    pickerHover: "none",
    pickerActive: false,
    requestPick(request) {
      set({ pickRequest: request === null ? null : { ...request } }); // fresh wrapper → re-fires
    },
    setPickerPoint(point) {
      set({ pickerPoint: point === null ? null : vec3(point[0], point[1], point[2]) });
    },
    setPickerHover(part) {
      if (part === get().pickerHover) return; // unchanged → no fire
      set({ pickerHover: part });
    },
    setPickerActive(active) {
      if (active === get().pickerActive) return; // unchanged → no fire
      set({ pickerActive: active });
    },
  };
}
