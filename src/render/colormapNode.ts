import { vec3 } from "three/tsl";
import type { Node } from "three/webgpu";
import { COLORMAP_COEFFS, type Rgb, resolveColormapName } from "./colormap.ts";

// GPU twin of colormapColor: the same degree-6 fit, evaluated in Horner form as a TSL
// node graph. Reads the shared COLORMAP_COEFFS so CPU reference and GPU output agree up
// to f32 rounding. Output saturated to [0,1] to match the CPU per-channel clamp.

/** Build a `t → vec3` colormap node for `name` (unknown names fall back to inferno). */
export function colormapNode(name: string): (t: Node<"float">) => Node<"vec3"> {
  const [c0, c1, c2, c3, c4, c5, c6] = COLORMAP_COEFFS[resolveColormapName(name)];
  const constant = (c: Rgb): Node<"vec3"> => vec3(c[0], c[1], c[2]);
  return (t) =>
    constant(c6)
      .mul(t)
      .add(constant(c5))
      .mul(t)
      .add(constant(c4))
      .mul(t)
      .add(constant(c3))
      .mul(t)
      .add(constant(c2))
      .mul(t)
      .add(constant(c1))
      .mul(t)
      .add(constant(c0))
      .saturate();
}
