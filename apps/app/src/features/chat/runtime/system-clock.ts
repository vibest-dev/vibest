export type ClockFeed = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
};

class SystemClock implements ClockFeed {
  readonly #listeners = new Set<() => void>();
  #snapshot = Date.now();
  #timer: ReturnType<typeof setInterval> | undefined;

  readonly getSnapshot = () => this.#snapshot;

  readonly #tick = () => {
    this.#snapshot = Date.now();
    for (const listener of this.#listeners) listener();
  };

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    this.#tick();
    this.#timer ??= setInterval(this.#tick, 1000);

    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size > 0 || this.#timer === undefined) return;
      clearInterval(this.#timer);
      this.#timer = undefined;
    };
  };
}

/** Shared wall clock for render-only countdowns. It runs only while observed. */
export const systemClock: ClockFeed = new SystemClock();
