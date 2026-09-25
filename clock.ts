export type TimerHandle = unknown;

/** Time source used by the scanner, injectable so tests can control time. */
export interface Clock {
  now(): number;
  /** Schedules a callback. Timers must not keep the process alive. */
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
