export type BackendConnection = {
  httpBaseUrl: string;
  wsBaseUrl: string;
  token: string;
};

/**
 * Lifecycle of the supervised backend process, mirrored to the renderer so it
 * can show a reconnecting overlay while a crashed server restarts, or a terminal
 * failure state when it gives up. See the supervisor for the transitions.
 */
export type BackendStatus = "starting" | "ready" | "reconnecting" | "failed";

/** How the renderer observes backend health and drives recovery. */
export type BackendStatusBridge = {
  /** Status at the moment the window loaded (always "ready" — the main process awaits it). */
  initial: BackendStatus;
  /** Subscribe to transitions; returns an unsubscribe. */
  subscribe: (listener: (status: BackendStatus) => void) => () => void;
  /** Clear a terminal "failed" state and try to bring the backend back. */
  retry: () => void;
  /** Quit the app (the terminal-state escape hatch). */
  quit: () => void;
};

/** The payload the preload fetches synchronously before the renderer's first module runs. */
export type Bootstrap = BackendConnection & {
  status: BackendStatus;
};

/** What the preload exposes to the renderer. Kept small on purpose. */
export type DesktopBridge = {
  os: string;
  backend: BackendConnection;
  status: BackendStatusBridge;
};
