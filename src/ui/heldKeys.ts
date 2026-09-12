import { isTypingTarget } from "./keyboard.ts";

// The keys physically held right now, for the two rAF-integrated holds (camera nudge keys, the
// marker's arrow slide). Keyed by event.code, not event.key — key is modifier-mutated ("=" releases
// as "+" once Shift is down), so a key-tracked set leaks entries and the motion runs away; code names
// the physical key on both edges. Beyond keyup, three things release the set: a Meta/Ctrl/Alt chord
// (macOS swallows keyups released under a held Meta, which would strand the set), a window blur (a
// tab switch never sends keyup), and the consumer's own drop(). Typing surfaces keep their keys.

export interface HeldKeysOptions {
  readonly signal: AbortSignal;
  // Extra claim test for a listed key; false leaves the keystroke to the page (no preventDefault).
  readonly claims?: (event: KeyboardEvent) => boolean;
  // A shifted keydown that isn't a claimed press counts as a chord too (drops the set like Meta).
  readonly shiftIsChord?: boolean;
  // After a claimed press — also on OS key-repeat, so a hold can re-read its modifiers.
  readonly onPress: (event: KeyboardEvent) => void;
  // After the set shrank: a keyup, a chord, a blur, or drop().
  readonly onRelease: () => void;
}

export interface HeldKeys {
  // The held codes — a live view; iterate it per frame without copying.
  readonly codes: ReadonlySet<string>;
  // Shift as of the latest key event: a hold's meaning can change mid-press.
  readonly isShiftHeld: boolean;
  // Release everything — the consumer's hard stop (e.g. the marker vanished mid-hold).
  drop(): void;
}

export function createHeldKeys(
  doc: Document,
  keys: ReadonlySet<string>,
  options: HeldKeysOptions,
): HeldKeys {
  const { signal } = options;
  const codes = new Set<string>();
  let isShiftHeld = false;

  const drop = (): void => {
    if (codes.size === 0) return;
    codes.clear();
    options.onRelease();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    isShiftHeld = event.shiftKey;
    if (event.metaKey || event.ctrlKey || event.altKey) {
      drop();
      return;
    }
    if (event.defaultPrevented || isTypingTarget(event.target)) return;
    if (!keys.has(event.code) || !(options.claims?.(event) ?? true)) {
      if (event.shiftKey && options.shiftIsChord === true) drop();
      return;
    }
    event.preventDefault(); // claimed — no quick-find / scroll side effects while held
    codes.add(event.code); // Set-idempotent, so OS key-repeat keydowns are harmless
    options.onPress(event);
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    isShiftHeld = event.shiftKey;
    if (codes.delete(event.code)) options.onRelease();
  };

  doc.addEventListener("keydown", onKeyDown, { signal });
  doc.addEventListener("keyup", onKeyUp, { signal });
  doc.defaultView?.addEventListener("blur", drop, { signal });

  return {
    codes,
    get isShiftHeld() {
      return isShiftHeld;
    },
    drop,
  };
}
