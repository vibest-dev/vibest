import type { SessionRuntimeSnapshot, SubscribeStreamEvent } from "@vibest/contract";
import { isSessionScopedEvent } from "@vibest/contract";

import { isAbortError, sleep } from "@/lib/utils";

import type { ChatTransportEvent } from "./chat-transport-port";

export type RecoveringSubscriptionOptions = {
  /** Open the wire subscription; aborting the signal cancels the event iterator. */
  readonly subscribe: (signal: AbortSignal) => Promise<AsyncIterable<SubscribeStreamEvent>>;
  readonly getSnapshot: () => Promise<SessionRuntimeSnapshot>;
  readonly onEvent: (event: ChatTransportEvent) => void;
  /** Backoff between recoveries; attempts are 1-indexed and reset by every attach. */
  readonly retryDelayMs: (attempt: number) => number;
};

/**
 * One persistent attachment to a session's event stream, with recovery built
 * in. Each cycle subscribes, snapshots, emits "attached", then pumps live
 * events; every exit that isn't `stop()` — server-side close, iterator error,
 * failed attach, even a naturally ended stream — backs off and re-attaches.
 * The live stream has no replay, so recovery is always a fresh attach + a
 * fresh snapshot, never a resume.
 */
export class RecoveringSubscription {
  readonly #controller = new AbortController();
  readonly #options: RecoveringSubscriptionOptions;
  #started = false;

  constructor(options: RecoveringSubscriptionOptions) {
    this.#options = options;
  }

  /** Idempotent: a second call must not race a second #run loop beside the
   * first — two loops would double-subscribe and double-deliver every event. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#run();
  }

  // Aborting #controller is the whole teardown: #open chains each cycle's own
  // controller to it, so the live iterator is cancelled through that listener.
  stop(): void {
    this.#controller.abort();
  }

  get #signal(): AbortSignal {
    return this.#controller.signal;
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#signal.aborted) {
      const outcome = await this.#attachOnce();
      if (outcome.terminal || this.#signal.aborted) return;
      // A completed attach resets the backoff: this exit is the first failure
      // of a new sequence, not a deeper retry.
      attempt = outcome.attached ? 1 : attempt + 1;
      await sleep(this.#options.retryDelayMs(attempt), this.#signal);
    }
  }

  /**
   * One attach cycle: `attached` is true when the snapshot was emitted, and
   * `terminal` ends the loop for good (the session itself is gone, so a
   * retry could only ever fail). Subscribe before the snapshot: an event
   * landing between the two is then waiting in the stream rather than lost,
   * and the consumer's cursor (seeded from the snapshot) drops the overlap.
   */
  async #attachOnce(): Promise<{ readonly attached: boolean; readonly terminal: boolean }> {
    let attached = false;
    try {
      const subscription = await this.#open();
      try {
        const snapshot = await this.#options.getSnapshot();
        if (this.#signal.aborted) return { attached, terminal: false };
        this.#options.onEvent({ type: "attached", snapshot });
        attached = true;
        for await (const item of subscription.events) {
          if (this.#signal.aborted) return { attached, terminal: false };
          if (item.type === "closed") {
            // The session being closed or deleted is terminal — surface it
            // and stop. Every other reason (slow_consumer today, anything
            // the server adds later) is a per-subscriber drop: recover by
            // re-attaching — the live stream has no replay.
            if (item.reason === "session_closed" || item.reason === "session_deleted") {
              this.#options.onEvent({ type: "closed", reason: item.reason });
              return { attached, terminal: true };
            }
            break;
          }
          if (isSessionScopedEvent(item.event)) this.#options.onEvent(item.event);
        }
      } finally {
        subscription.close();
      }
    } catch (streamError) {
      // Terminal only when *we* stopped. A dead socket also surfaces as an
      // AbortError (the link aborts in-flight calls when the connection
      // drops), and that one must recover like any failure.
      if (!this.#signal.aborted && !isAbortError(streamError)) {
        console.error("Session events stream error:", streamError);
      }
    }
    return { attached, terminal: false };
  }

  /**
   * Open one subscription under its own controller chained to `stop()` —
   * aborting it is what actually cancels the oRPC event iterator.
   */
  async #open(): Promise<{
    readonly events: AsyncIterable<SubscribeStreamEvent>;
    readonly close: () => void;
  }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (this.#signal.aborted) abort();
    else this.#signal.addEventListener("abort", abort, { once: true });
    try {
      const events = await this.#options.subscribe(controller.signal);
      return {
        events,
        close: () => {
          this.#signal.removeEventListener("abort", abort);
          abort();
        },
      };
    } catch (error) {
      this.#signal.removeEventListener("abort", abort);
      throw error;
    }
  }
}
