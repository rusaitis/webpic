import { beforeEach, describe, expect, it } from "vitest";
import { GESTURE_THRESHOLD_PX, VIEWPORT_MARGIN_PX } from "../layout.ts";
import { installCornerResize } from "./cornerResize.ts";

// happy-dom reports every rect as 0x0, so the element's geometry is stubbed per test. What is
// exercised here is the installer — reading the start rect, writing the inline width/height, the
// far-edge clamp against the viewport, and teardown. The dimension arithmetic is pure and lives in
// cornerResize.test.ts.

const VIEWPORT = { width: 1000, height: 800 };

function press(element: HTMLElement, type: string, x: number, y: number): void {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  Object.assign(event, { clientX: x, clientY: y, pointerId: 1, isPrimary: true });
  element.dispatchEvent(event);
}

function setup(rect = { left: 100, top: 80, w: 300, h: 200 }) {
  const element = document.createElement("div");
  const handle = document.createElement("div");
  element.append(handle);
  document.body.append(element);
  element.getBoundingClientRect = () =>
    ({
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.w,
      bottom: rect.top + rect.h,
      width: rect.w,
      height: rect.h,
    }) as DOMRect;
  return { element, handle };
}

beforeEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: VIEWPORT.width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: VIEWPORT.height,
    configurable: true,
  });
});

describe("installCornerResize", () => {
  it("grows the element by the drag delta, leaving its top-left where it was", () => {
    const { element, handle } = setup();
    installCornerResize(element, handle);

    press(handle, "pointerdown", 400, 280);
    press(handle, "pointermove", 460, 330);
    press(handle, "pointerup", 460, 330);

    expect(element.style.width).toBe("360px");
    expect(element.style.height).toBe("250px");
    expect(element.style.left).toBe("");
    expect(element.style.top).toBe("");
  });

  it("leaves a sub-threshold press alone, so a click on the grip is not a resize", () => {
    const { element, handle } = setup();
    installCornerResize(element, handle);

    press(handle, "pointerdown", 400, 280);
    press(handle, "pointermove", 400 + GESTURE_THRESHOLD_PX / 2, 280);
    press(handle, "pointerup", 400, 280);

    expect(element.style.width).toBe("");
  });

  it("carries is-resizing for the duration of the gesture", () => {
    const { element, handle } = setup();
    installCornerResize(element, handle);

    press(handle, "pointerdown", 400, 280);
    expect(element.classList.contains("is-resizing")).toBe(false);

    press(handle, "pointermove", 460, 330);
    expect(element.classList.contains("is-resizing")).toBe(true);

    press(handle, "pointerup", 460, 330);
    expect(element.classList.contains("is-resizing")).toBe(false);
  });

  it("refuses to shrink below the minimum size", () => {
    const { element, handle } = setup();
    installCornerResize(element, handle, { minWidth: 200, minHeight: 150 });

    press(handle, "pointerdown", 400, 280);
    press(handle, "pointermove", 100, 40);

    expect(element.style.width).toBe("200px");
    expect(element.style.height).toBe("150px");
  });

  it("clamps growth to the viewport past the element's own left and top", () => {
    const { element, handle } = setup({ left: 100, top: 80, w: 300, h: 200 });
    installCornerResize(element, handle);

    press(handle, "pointerdown", 400, 280);
    press(handle, "pointermove", 5000, 5000);

    expect(element.style.width).toBe(`${VIEWPORT.width - 100 - VIEWPORT_MARGIN_PX}px`);
    expect(element.style.height).toBe(`${VIEWPORT.height - 80 - VIEWPORT_MARGIN_PX}px`);
  });

  it("honors an explicit margin in place of the default viewport breathing room", () => {
    const { element, handle } = setup({ left: 100, top: 80, w: 300, h: 200 });
    installCornerResize(element, handle, { margin: 0 });

    press(handle, "pointerdown", 400, 280);
    press(handle, "pointermove", 5000, 5000);

    expect(element.style.width).toBe(`${VIEWPORT.width - 100}px`);
  });

  it("reports each applied size change so content can reflow", () => {
    const { element, handle } = setup();
    let resizes = 0;
    installCornerResize(element, handle, { onResize: () => resizes++ });

    press(handle, "pointerdown", 400, 280);
    press(handle, "pointermove", 460, 330);
    press(handle, "pointermove", 470, 340);

    expect(resizes).toBe(2);
  });

  it("stops responding once disposed", () => {
    const { element, handle } = setup();
    const dispose = installCornerResize(element, handle);
    dispose();

    press(handle, "pointerdown", 400, 280);
    press(handle, "pointermove", 460, 330);

    expect(element.style.width).toBe("");
  });

  it("is idempotent on dispose", () => {
    const { element, handle } = setup();
    const dispose = installCornerResize(element, handle);
    dispose();
    dispose();

    press(handle, "pointerdown", 400, 280);
    press(handle, "pointermove", 460, 330);

    expect(element.style.width).toBe("");
  });
});
