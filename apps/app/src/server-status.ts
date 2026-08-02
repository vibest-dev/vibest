/** Lifecycle of a server managed outside the shared app. */
export type ServerStatus = "starting" | "ready" | "reconnecting" | "failed";

/** How the UI observes server health and requests host-managed recovery. */
export type ServerStatusFeed = {
  /**
   * The status right now — the host's own view, not a React copy of it. Pairs
   * with `subscribe` to make this feed a `useSyncExternalStore` source.
   */
  getSnapshot: () => ServerStatus;
  /** Subscribe to transitions; returns an unsubscribe. */
  subscribe: (listener: (status: ServerStatus) => void) => () => void;
  /** Clear a terminal "failed" state and try to bring the server back. */
  retry: () => void;
};
