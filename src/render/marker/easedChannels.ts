// The marker's hover / pulse / active feel is nine scalars, each exponentially approaching its own
// target at its own rate. Held here as named cells rather than nine `x`/`xT` pairs in the scene, so
// the step and the settle test are written once and can be tested without a GPU.

// Frame-rate-independent approach factor for a decay rate (dt in seconds, pre-clamped by the caller
// so a tab-switch stall can't snap an animation).
export function easeStep(dt: number, rate: number): number {
  return 1 - Math.exp(-rate * dt);
}

// |value − target| below this counts as settled, so the render loop can go idle.
const SETTLE_EPS = 1e-3;

export interface ChannelSpec {
  readonly rate: number;
  readonly initial?: number;
}

export interface EasedChannels<K extends string> {
  get(key: K): number;
  // Move where a channel is heading; it eases there over the following frames.
  setTarget(key: K, value: number): void;
  // Jump a channel to `value` without moving its target — the click pulse, which spikes to 1 and
  // then decays back to a target of 0.
  spike(key: K, value: number): void;
  // Step every channel one frame. True while any is still moving, which is what keeps the
  // on-demand render loop painting.
  advance(dt: number): boolean;
}

export function createEasedChannels<K extends string>(
  specs: Readonly<Record<K, ChannelSpec>>,
): EasedChannels<K> {
  const keys = Object.keys(specs) as K[];
  const values = new Map<K, number>();
  const targets = new Map<K, number>();
  for (const key of keys) {
    const initial = specs[key].initial ?? 0;
    values.set(key, initial);
    targets.set(key, initial);
  }
  return {
    get: (key) => values.get(key) ?? 0,
    setTarget(key, value) {
      targets.set(key, value);
    },
    spike(key, value) {
      values.set(key, value);
    },
    advance(dt) {
      let isMoving = false;
      for (const key of keys) {
        const value = values.get(key) ?? 0;
        const target = targets.get(key) ?? 0;
        values.set(key, value + (target - value) * easeStep(dt, specs[key].rate));
        if (Math.abs(target - (values.get(key) ?? 0)) > SETTLE_EPS) isMoving = true;
      }
      return isMoving;
    },
  };
}
