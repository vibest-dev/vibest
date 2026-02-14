/**
 * Publisher interface for event streaming.
 *
 * Abstracts away the concrete event publishing mechanism (e.g. oRPC MemoryPublisher)
 * so that services remain framework-agnostic.
 */
export interface Publisher<TEvents extends Record<string, unknown> = Record<string, unknown>> {
  publish<K extends keyof TEvents & string>(channel: K, event: TEvents[K]): void;
  subscribe<K extends keyof TEvents & string>(
    channel: K,
    options: { signal: AbortSignal },
  ): AsyncIterable<TEvents[K]>;
}
