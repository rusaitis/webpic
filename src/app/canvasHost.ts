// The canvas bootstrap owns before any worker exists: create it, mount it, read its logical size,
// and hand its drawing surface to the render worker. Injectable at every step so the headless
// handshake test can bootstrap without a DOM.

const DEFAULT_SIZE = 256;

export interface CanvasHostOptions {
  readonly width?: number;
  readonly height?: number;
  readonly createCanvas?: () => HTMLCanvasElement;
  readonly mount?: (canvas: HTMLCanvasElement) => void;
}

interface CanvasHost {
  readonly canvas: HTMLCanvasElement;
  readonly offscreen: OffscreenCanvas;
  // Logical (CSS) size of the mounted element; explicit options win for the headless test. The
  // worker scales this by devicePixelRatio for the drawing buffer.
  logicalSize(): { width: number; height: number };
}

export function createCanvasHost(options: CanvasHostOptions): CanvasHost {
  const width = options.width ?? DEFAULT_SIZE;
  const height = options.height ?? DEFAULT_SIZE;

  const canvas =
    options.createCanvas?.() ??
    (() => {
      const element = document.createElement("canvas");
      element.width = width;
      element.height = height;
      return element;
    })();

  const mount =
    options.mount ??
    ((element: HTMLCanvasElement) => {
      // The FCP splash pill lives outside #app and survives this; installStatusPill adopts it.
      (document.getElementById("app") ?? document.body).replaceChildren(element);
    });
  mount(canvas);

  return {
    canvas,
    offscreen: canvas.transferControlToOffscreen(),
    logicalSize: () => ({
      width: options.width ?? (canvas.clientWidth || DEFAULT_SIZE),
      height: options.height ?? (canvas.clientHeight || DEFAULT_SIZE),
    }),
  };
}
