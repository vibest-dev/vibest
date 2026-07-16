/** Lifecycle of a server managed outside the shared app. */
export type ServerStatus = "starting" | "ready" | "reconnecting" | "failed";

/** How the UI observes server health and requests host-managed recovery. */
export type ServerStatusFeed = {
  /** Status when the React tree mounts, before the first streamed update. */
  initial: ServerStatus;
  /** Subscribe to transitions; returns an unsubscribe. */
  subscribe: (listener: (status: ServerStatus) => void) => () => void;
  /** Clear a terminal "failed" state and try to bring the server back. */
  retry: () => void;
};
