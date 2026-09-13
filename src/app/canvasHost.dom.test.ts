import { beforeEach, describe, expect, it } from "vitest";
import { createCanvasHost } from "./canvasHost.ts";

// The default construction + mount paths only run when the caller injects neither createCanvas nor
// mount, which a node suite cannot do — bootstrap.test.ts injects both by necessity.

beforeEach(() => {
  document.body.replaceChildren();
});

describe("createCanvasHost", () => {
  it("mounts the canvas it built into #app when the element is present", () => {
    const app = document.createElement("div");
    app.id = "app";
    document.body.append(app);

    const host = createCanvasHost({ width: 64, height: 32 });

    expect(app.children).toHaveLength(1);
    expect(app.firstElementChild).toBe(host.canvas);
    expect(host.canvas.tagName).toBe("CANVAS");
  });

  it("falls back to the body when there is no #app to mount into", () => {
    const host = createCanvasHost({ width: 64, height: 32 });

    expect(document.body.firstElementChild).toBe(host.canvas);
  });

  it("replaces whatever was already mounted, so a re-install leaves one canvas", () => {
    const app = document.createElement("div");
    app.id = "app";
    app.append(document.createElement("span"));
    document.body.append(app);

    const host = createCanvasHost({ width: 8, height: 8 });

    expect([...app.children]).toEqual([host.canvas]);
  });

  it("sizes the drawing buffer from the requested width and height", () => {
    const host = createCanvasHost({ width: 64, height: 32 });

    expect([host.canvas.width, host.canvas.height]).toEqual([64, 32]);
  });

  it("falls back to a 256 square when no size is requested", () => {
    const host = createCanvasHost({});

    expect([host.canvas.width, host.canvas.height]).toEqual([256, 256]);
  });

  it("hands out an offscreen surface carrying the canvas's buffer size", () => {
    const host = createCanvasHost({ width: 16, height: 48 });

    expect([host.offscreen.width, host.offscreen.height]).toEqual([16, 48]);
  });

  it("prefers the requested logical size over the mounted element's measurement", () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 999 });
    Object.defineProperty(canvas, "clientHeight", { value: 999 });

    const host = createCanvasHost({
      width: 64,
      height: 32,
      createCanvas: () => canvas,
      mount: () => {},
    });

    expect(host.logicalSize()).toEqual({ width: 64, height: 32 });
  });

  it("measures the mounted element when no logical size was requested", () => {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "clientWidth", { value: 300 });
    Object.defineProperty(canvas, "clientHeight", { value: 150 });

    const host = createCanvasHost({ createCanvas: () => canvas, mount: () => {} });

    expect(host.logicalSize()).toEqual({ width: 300, height: 150 });
  });

  it("falls back to 256 when the element measures zero, so the worker never gets a 0-size buffer", () => {
    const host = createCanvasHost({ createCanvas: () => document.createElement("canvas") });

    expect(host.logicalSize()).toEqual({ width: 256, height: 256 });
  });

  it("uses the injected canvas and mount instead of touching the document", () => {
    const canvas = document.createElement("canvas");
    const mounted: HTMLCanvasElement[] = [];

    const host = createCanvasHost({
      createCanvas: () => canvas,
      mount: (element) => mounted.push(element),
    });

    expect(host.canvas).toBe(canvas);
    expect(mounted).toEqual([canvas]);
    expect(document.body.children).toHaveLength(0);
  });
});
