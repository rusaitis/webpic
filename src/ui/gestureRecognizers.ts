// The two pure state machines behind the touch gestures in cameraGestures.ts: whether a two-finger
// move is a deliberate twist or an incidental wobble during a pinch-zoom, and whether a release
// completes a double-tap. Both are decisions over a stream of numbers with no DOM and no store, so
// they are unit-tested directly rather than through a synthesized pointer sequence.

const TWIST_ENGAGE_PX = 30; // tangential fingertip arc (px) before banking can engage
const TWIST_DOMINANCE = 1.5; // ...and the twist travel must outweigh the zoom travel by this factor

export interface TwistGate {
  // Feed one two-finger move: the shortest-arc angle delta, the finger spread, and the change in
  // spread. Returns true once banking is live — pre-gate rotation is discarded, so the bank tracks
  // the fingers 1:1 from the moment it engages instead of catching up with a jump.
  advance(deltaTwist: number, spread: number, deltaSpread: number): boolean;
  reset(): void;
}

// A pinch decomposes into radial (zoom) and tangential (twist) fingertip travel. Roll engages only
// once the tangential travel clears a floor AND outweighs the radial — so a plain pinch-zoom,
// however wobbly, never banks, while a deliberate finger-orbit does.
export function createTwistGate(): TwistGate {
  let twistTravelPx = 0;
  let zoomTravelPx = 0;
  let isEngaged = false;
  return {
    advance(deltaTwist, spread, deltaSpread) {
      if (isEngaged) return true;
      twistTravelPx += Math.abs(deltaTwist) * spread; // arc length swept at the orbiting finger
      zoomTravelPx += Math.abs(deltaSpread);
      isEngaged =
        twistTravelPx >= TWIST_ENGAGE_PX && twistTravelPx >= TWIST_DOMINANCE * zoomTravelPx;
      return isEngaged;
    },
    reset() {
      twistTravelPx = 0;
      zoomTravelPx = 0;
      isEngaged = false;
    },
  };
}

const TAP_SLOP_PX = 10; // a press that travelled farther was a drag, not a tap
const TAP_MAX_MS = 500; // a press held longer was a press-and-hold, not a tap
const DBL_TAP_MS = 300; // two taps within this window pair into a double-tap
const DBL_TAP_SLOP_PX = 30; // ...and landing within this distance of each other

export interface TapRelease {
  readonly x: number;
  readonly y: number;
  readonly atMs: number;
  readonly heldMs: number;
  readonly travelPx: number;
  // A pinch happened at some point in this gesture, so no release in it can be a tap.
  readonly wasMultiTouch: boolean;
}

export interface TapRecognizer {
  // Report a pointerup. True when it completes a double-tap; the pair is consumed, so a third tap
  // starts a fresh chain rather than firing again.
  isDoubleTap(release: TapRelease): boolean;
  // An interruption (pointercancel, lost capture, a drag) breaks the chain.
  breakChain(): void;
}

// Touch/pen double-tap → the same focus a mouse gets from dblclick. Mobile UX thresholds.
export function createTapRecognizer(): TapRecognizer {
  let lastTapMs = Number.NEGATIVE_INFINITY;
  let lastTapX = 0;
  let lastTapY = 0;
  const breakChain = (): void => {
    lastTapMs = Number.NEGATIVE_INFINITY;
  };
  return {
    isDoubleTap(release) {
      const isTap =
        !release.wasMultiTouch && release.heldMs <= TAP_MAX_MS && release.travelPx <= TAP_SLOP_PX;
      if (!isTap) {
        breakChain();
        return false;
      }
      const pairsWithLast =
        release.atMs - lastTapMs <= DBL_TAP_MS &&
        Math.hypot(release.x - lastTapX, release.y - lastTapY) <= DBL_TAP_SLOP_PX;
      if (pairsWithLast) {
        breakChain(); // consume — a third tap doesn't chain
        return true;
      }
      lastTapMs = release.atMs;
      lastTapX = release.x;
      lastTapY = release.y;
      return false;
    },
    breakChain,
  };
}
