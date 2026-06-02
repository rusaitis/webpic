import { fieldInfo } from "@schema/registry.ts";
import type { FieldName } from "@schema/types.ts";
import type { ControlHandle, Folder, SelectOption } from "../controls/index.ts";

// Schema-aware, declarative control binding. A descriptor's `canonicalName` resolves
// its label from the field registry (loud throw on an unknown name — pypic's KeyError
// rule), so labels stay in sync with pypic without codegen. Note: the registry carries
// no numeric ranges (FieldMeta = longName/latex/siUnit/quantityType), so slider
// min/max/step come from the descriptor, not the registry.

interface BaseDescriptor {
  readonly canonicalName?: FieldName;
  readonly label?: string;
}

export interface SliderDescriptor extends BaseDescriptor {
  readonly kind: "slider";
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly format?: (value: number) => string;
  readonly onChange: (value: number) => void;
}

export interface SelectDescriptor<V extends string = string> extends BaseDescriptor {
  readonly kind: "select";
  readonly value: V;
  readonly options: ReadonlyArray<SelectOption<V>>;
  readonly onChange: (value: V) => void;
}

export interface CheckboxDescriptor extends BaseDescriptor {
  readonly kind: "checkbox";
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}

export interface TextDescriptor extends BaseDescriptor {
  readonly kind: "text";
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export type ControlDescriptor =
  | SliderDescriptor
  | SelectDescriptor
  | CheckboxDescriptor
  | TextDescriptor;

// The field's human label from the registry — used for control labels and option text.
export function fieldLabel(name: FieldName): string {
  return fieldInfo(name).longName;
}

function resolveLabel(desc: BaseDescriptor): string {
  if (desc.label !== undefined) return desc.label;
  if (desc.canonicalName !== undefined) {
    const info = fieldInfo(desc.canonicalName);
    return info.siUnit ? `${info.longName} (${info.siUnit})` : info.longName;
  }
  throw new Error("ControlDescriptor requires either `label` or `canonicalName`");
}

export function bindControl(
  folder: Folder,
  desc: ControlDescriptor,
): ControlHandle<number> | ControlHandle<string> | ControlHandle<boolean> {
  const label = resolveLabel(desc);
  switch (desc.kind) {
    case "slider":
      return folder.addSlider({
        label,
        value: desc.value,
        min: desc.min,
        max: desc.max,
        // exactOptionalPropertyTypes: include optional keys only when set.
        ...(desc.step !== undefined ? { step: desc.step } : {}),
        ...(desc.format !== undefined ? { format: desc.format } : {}),
        onChange: desc.onChange,
      });
    case "select":
      return folder.addSelect({
        label,
        value: desc.value,
        options: desc.options,
        onChange: desc.onChange,
      });
    case "checkbox":
      return folder.addCheckbox({ label, value: desc.value, onChange: desc.onChange });
    case "text":
      return folder.addText({ label, value: desc.value, onChange: desc.onChange });
    default: {
      const _exhaustive: never = desc;
      return _exhaustive;
    }
  }
}
