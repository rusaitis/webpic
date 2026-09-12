import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GESTURE_THRESHOLD_PX } from "../layout.ts";
import { installDragSnap, readEdge } from "./dragSnap.ts";

// happy-dom reports every rect as 0×0, so the element's live geometry is stubbed per test. What is
// exercised here is the installer's own behavior — reading the drop rect, writing the CSS custom
// properties and inline anchors, and tearing down — not the placement arithmetic, which is pure and
// tested in snapGeometry.test.ts.

const VIEWPORT = { width: 1000, height: 800 };

function press(element: HTMLElement, type: string, x: number, y: number): void {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1, isPrimary: true });
  element.dispatchEvent(event);
}

// Pretend the element occupies `rect`, offset by whatever the live drag transform says.
function stubRect(element: HTMLElement, rect: { left: number; top: number; w: number; h: number }) {
  element.getBoundingClientRect = () => {
    const dx = Number.parseFloat(element.style.getPropertyValue("--drag-x")) || 0;
    const dy = Number.parseFloat(element.style.getPropertyValue("--drag-y")) || 0;
    return {
      left: rect.left + dx,
      top: rect.top + dy,
      right: rect.left + dx + rect.w,
      bottom: rect.top + dy + rect.h,
      width: rect.w,
      height: rect.h,
    } as DOMRect;
  };
}

describe("installDragSnap", () => {
  let element: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(VIEWPORT.width);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(VIEWPORT.height);
    element = document.createElement("div");
    document.body.appendChild(element);
    element.releasePointerCapture = vi.fn();
    element.setPointerCapture = vi.fn();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("tracks the pointer on --drag-x/--drag-y once past the gesture threshold", () => {
    stubRect(element, { left: 400, top: 300, w: 200, h: 40 });
    const controller = installDragSnap(element);

    press(element, "pointerdown", 500, 320);
    press(element, "pointermove", 500 + GESTURE_THRESHOLD_PX / 2, 320);
    expect(element.style.getPropertyValue("--drag-x")).toBe(""); // sub-threshold: still a click

    press(element, "pointermove", 500 + 60, 320 + 10);
    expect(element.style.getPropertyValue("--drag-x")).toBe("60px");
    expect(element.style.getPropertyValue("--drag-y")).toBe("10px");
    controller.dispose();
  });

  it("docks to the nearest edge on release and records it in data-edge", () => {
    stubRect(element, { left: 400, top: 300, w: 200, h: 40 });
    const edges: string[] = [];
    const controller = installDragSnap(element, { onEdgeChange: (edge) => edges.push(edge) });

    press(element, "pointerdown", 500, 320);
    press(element, "pointermove", 500, 320 - 290); // drag the strip up to the top edge
    press(element, "pointerup", 500, 320 - 290);

    expect(readEdge(element)).toBe("top");
    expect(edges).toEqual(["top"]);
    expect(element.dataset.docked).toBe("true");
    expect(element.style.top).not.toBe(""); // flushed to the edge via an inline anchor
    expect(element.style.getPropertyValue("--drag-x")).toBe("0px"); // transform folded into the anchor
    controller.dispose();
  });

  it("keeps a drop released in open space where it landed", () => {
    stubRect(element, { left: 400, top: 300, w: 200, h: 40 });
    const controller = installDragSnap(element);

    press(element, "pointerdown", 500, 320);
    press(element, "pointermove", 520, 330);
    press(element, "pointerup", 520, 330);

    expect(element.dataset.docked).toBe("false");
    controller.dispose();
  });

  it("reports a release for one tick so the trailing click can be swallowed", () => {
    stubRect(element, { left: 400, top: 300, w: 200, h: 40 });
    const controller = installDragSnap(element);
    expect(controller.wasDragging()).toBe(false);

    press(element, "pointerdown", 500, 320);
    press(element, "pointermove", 560, 320);
    press(element, "pointerup", 560, 320);
    expect(controller.wasDragging()).toBe(true);

    const click = new Event("click", { bubbles: true, cancelable: true });
    element.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true); // the drag's trailing click never reaches a handler
    expect(controller.wasDragging()).toBe(false); // and it is consumed
    controller.dispose();
  });

  it("declines a press that starts on a button, leaving the control clickable", () => {
    stubRect(element, { left: 400, top: 300, w: 200, h: 40 });
    const button = document.createElement("button");
    element.appendChild(button);
    const controller = installDragSnap(element);

    press(button, "pointerdown", 500, 320);
    press(button, "pointermove", 560, 320);
    expect(element.style.getPropertyValue("--drag-x")).toBe("");
    controller.dispose();
  });

  it("stops responding to a drag that is still in progress when it is disposed", () => {
    stubRect(element, { left: 400, top: 300, w: 200, h: 40 });
    const controller = installDragSnap(element);

    press(element, "pointerdown", 500, 320);
    press(element, "pointermove", 560, 320);
    expect(element.style.getPropertyValue("--drag-x")).toBe("60px");

    controller.dispose();
    press(element, "pointermove", 700, 320);
    expect(element.style.getPropertyValue("--drag-x")).toBe("60px"); // frozen at the last live move
  });

  it("stays torn down after a second dispose", () => {
    stubRect(element, { left: 400, top: 300, w: 200, h: 40 });
    const controller = installDragSnap(element);
    controller.dispose();
    controller.dispose(); // a defensive double-dispose must not re-arm anything

    press(element, "pointerdown", 500, 320);
    press(element, "pointermove", 560, 320);
    expect(element.style.getPropertyValue("--drag-x")).toBe("");
  });

  it("holds a hidden element's inline placement rather than anchoring it to the origin", () => {
    element.style.left = "120px";
    element.style.top = "40px";
    stubRect(element, { left: 0, top: 0, w: 0, h: 0 }); // display:none measures 0x0
    const controller = installDragSnap(element);

    controller.reflow();

    expect(element.style.left).toBe("120px"); // untouched: reflowing a 0x0 rect would clobber it
    expect(element.style.top).toBe("40px");
    controller.dispose();
  });
});
