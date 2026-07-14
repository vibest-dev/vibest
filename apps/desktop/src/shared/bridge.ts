export type BackendConnection = {
  httpBaseUrl: string;
  wsBaseUrl: string;
  token: string;
};

/** What the preload exposes to the renderer. Kept small on purpose. */
export type DesktopBridge = {
  os: string;
  backend: BackendConnection;
};
