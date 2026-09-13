import { beforeEach, describe, expect, it, vi } from "vitest";
import { GESTURE_THRESHOLD_PX } from "../layout.ts";
import { bindPressDrag } from "./pressDrag.ts";

function press(element: HTMLElement, type: string, x: number, y: number, pointerId = 1): void {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  Object.assign(event, { clientX: x, clientY: y, pointerId, isPrimary: pointerId === 1 });
  element.dispatchEvent(event);
}

describe("bindPressDrag", () => {
  let element: HTMLElement;
  let moves: Array<[number, number]>;
  let ends: number;
  let abortController: AbortController;

  beforeEach(() => {
    document.body.replaceChildren();
    element = document.createElement("div");
    document.body.appendChild(element);
    moves = [];
    ends = 0;
    abortController = new AbortController();
    bindPressDrag({
      handle: element,
      element,
      activeClass: "is-dragging",
      signal: abortController.signal,
      onMove: (dx, dy) => moves.push([dx, dy]),
      onEnd: () => {
        ends += 1;
      },
    });
  });

  it("stays a click below the movement threshold", () => {
    press(element, "pointerdown", 0, 0);
    press(element, "pointermove", GESTURE_THRESHOLD_PX - 1, 0);
    press(element, "pointerup", GESTURE_THRESHOLD_PX - 1, 0);
    expect(moves).toEqual([]);
    expect(ends).toBe(0);
    expect(element.classList.contains("is-dragging")).toBe(false);
  });

  it("arms past the threshold and reports deltas from the press point", () => {
    press(element, "pointerdown", 10, 10);
    press(element, "pointermove", 40, 30);
    expect(element.classList.contains("is-dragging")).toBe(true);
    press(element, "pointermove", 41, 30);
    expect(moves).toEqual([
      [30, 20],
      [31, 20],
    ]);
  });

  it("ends the gesture on release, clearing the class exactly once", () => {
    press(element, "pointerdown", 0, 0);
    press(element, "pointermove", 50, 0);
    press(element, "pointerup", 50, 0);
    expect(ends).toBe(1);
    expect(element.classList.contains("is-dragging")).toBe(false);
    press(element, "pointerup", 50, 0); // a stray second release must not re-fire
    expect(ends).toBe(1);
  });

  it("ends the gesture on pointercancel, like a release", () => {
    press(element, "pointerdown", 0, 0);
    press(element, "pointermove", 50, 0);
    press(element, "pointercancel", 50, 0);
    expect(ends).toBe(1);
  });

  it("ignores a non-primary pointer and moves from a pointer it never captured", () => {
    press(element, "pointerdown", 0, 0, 2); // secondary finger
    press(element, "pointermove", 50, 0, 2);
    expect(moves).toEqual([]);

    press(element, "pointerdown", 0, 0);
    press(element, "pointermove", 50, 0, 7); // a different pointer mid-gesture
    expect(moves).toEqual([]);
  });

  it("declines the press when onStart returns false", () => {
    document.body.replaceChildren();
    const target = document.createElement("div");
    document.body.appendChild(target);
    const onMove = vi.fn();
    bindPressDrag({
      handle: target,
      element: target,
      activeClass: "is-dragging",
      signal: new AbortController().signal,
      onStart: () => false,
      onMove,
    });
    press(target, "pointerdown", 0, 0);
    press(target, "pointermove", 50, 0);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("stops listening when the signal aborts", () => {
    abortController.abort();
    press(element, "pointerdown", 0, 0);
    press(element, "pointermove", 50, 0);
    expect(moves).toEqual([]);
  });
});
