/** Where the desktop shell's spawned backend is listening, and how to talk to it. */
export type BackendConnection = {
  /** e.g. "http://127.0.0.1:41234" */
  httpBaseUrl: string;
  /** e.g. "ws://127.0.0.1:41234" */
  wsBaseUrl: string;
  /** Per-launch bearer token. Never persisted. */
  token: string;
};

/** Lifecycle of the desktop shell's supervised backend process. */
export type BackendStatus = "starting" | "ready" | "reconnecting" | "failed";

/**
 * How the desktop UI observes backend health and drives recovery. The shell
 * restarts a crashed backend transparently; this feed lets the renderer show a
 * reconnecting overlay meanwhile, and offer Retry/Quit if it gives up.
 */
export type BackendStatusFeed = {
  /** Status when the window loaded (always "ready" — the shell awaits it first). */
  initial: BackendStatus;
  /** Subscribe to transitions; returns an unsubscribe. */
  subscribe: (listener: (status: BackendStatus) => void) => () => void;
  /** Clear a terminal "failed" state and try to bring the backend back. */
  retry: () => void;
  /** Quit the app. */
  quit: () => void;
};

/**
 * The host this UI is running in, injected by the entry point — never sniffed
 * at runtime. Browser mode is same-origin and needs no connection details; the
 * Electron renderer loads from `vibest://app` and must be told where its
 * backend is. Desktop-only capabilities (a native directory picker, for one)
 * belong on the `desktop` arm, where the compiler keeps web code away from them.
 */
export type Platform =
  | { host: "web" }
  | { host: "desktop"; os: string; backend: BackendConnection; status: BackendStatusFeed };
