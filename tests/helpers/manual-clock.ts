import type {Clock, TimerHandle} from '../../clock.js';

interface Timer {
  id: number;
  at: number;
  callback: () => void;
}

/**
 * A deterministic clock. Time only moves when a test calls `advance`, `advanceTo`, or `runAll`,
 * and pending promise continuations are drained after every timer so async code can react.
 */
export class ManualClock implements Clock {
  private currentTime: number;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  constructor(startTime = 0) {
    this.currentTime = startTime;
  }

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, {id, at: this.currentTime + Math.max(0, ms), callback});
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** Resolves after `ms` of simulated time. */
  sleep(ms: number): Promise<void> {
    return new Promise(resolve => this.setTimeout(resolve, ms));
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Time of the next scheduled timer, or `null` when none are pending. */
  get nextTimerAt(): number | null {
    return this.nextTimer()?.at ?? null;
  }

  /** Lets every queued promise continuation run without moving time. */
  async flush(): Promise<void> {
    // Node drains the entire microtask queue before running an immediate.
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.currentTime + ms);
  }

  /** Fires every timer due up to `time` in order, then settles at `time`. */
  async advanceTo(time: number): Promise<void> {
    if (time < this.currentTime) {
      throw new Error(`Cannot move the clock backwards from ${this.currentTime} to ${time}`);
    }

    await this.flush();
    for (let timer = this.nextTimer(); timer && timer.at <= time; timer = this.nextTimer()) {
      this.fire(timer);
      await this.flush();
    }
    this.currentTime = time;
    await this.flush();
  }

  /** Fires timers until none remain. Throws if more than `limit` fire (a runaway loop). */
  async runAll({limit = 100_000}: {limit?: number} = {}): Promise<void> {
    await this.flush();
    let fired = 0;
    for (let timer = this.nextTimer(); timer; timer = this.nextTimer()) {
      if (++fired > limit) {
        throw new Error(`ManualClock.runAll fired more than ${limit} timers`);
      }
      this.fire(timer);
      await this.flush();
    }
  }

  private nextTimer(): Timer | undefined {
    let next: Timer | undefined;
    for (const timer of this.timers.values()) {
      if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) {
        next = timer;
      }
    }
    return next;
  }

  private fire(timer: Timer): void {
    this.timers.delete(timer.id);
    this.currentTime = Math.max(this.currentTime, timer.at);
    timer.callback();
  }
}
