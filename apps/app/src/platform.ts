/** Where the desktop shell's spawned backend is listening, and how to talk to it. */
export type BackendConnection = {
  /** e.g. "http://127.0.0.1:41234" */
  httpBaseUrl: string;
  /** e.g. "ws://127.0.0.1:41234" */
  wsBaseUrl: string;
  /** Per-launch bearer token. Never persisted. */
  token: string;
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
  | { host: "desktop"; os: string; backend: BackendConnection };
