export const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

/** Resolves after `ms`, or immediately when the signal aborts — never rejects. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    // An already-aborted signal never fires "abort"; settle up front.
    if (signal?.aborted) {
      resolve();
      return;
    }
    const settle = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolve();
    };
    const timer = setTimeout(settle, ms);
    signal?.addEventListener("abort", settle, { once: true });
  });

/** Exponential backoff delays: `baseMs` doubling per attempt (1-indexed), capped at `capMs`. */
export const exponentialBackoffMs =
  (baseMs: number, capMs: number) =>
  (attempt: number): number =>
    Math.min(baseMs * 2 ** (attempt - 1), capMs);
