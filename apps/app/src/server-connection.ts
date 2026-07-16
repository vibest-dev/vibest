/** A resolved server endpoint used to configure the shared app's RPC client. */
export type ServerConnection = {
  /** e.g. "http://127.0.0.1:41234" */
  httpBaseUrl: string;
  /** e.g. "ws://127.0.0.1:41234" */
  wsBaseUrl: string;
  /** Per-launch bearer token. Never persisted. */
  token: string;
};
