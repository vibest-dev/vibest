import { contextBridge, ipcRenderer } from "electron";

import type { BackendStatus, Bootstrap, DesktopBridge } from "../shared/bridge";

// Synchronous on purpose: the renderer's first module needs the backend's
// origin and token, and the main process already has both by the time this
// window exists (it awaits the backend before creating the window).
const bootstrap = ipcRenderer.sendSync("vibest:bootstrap") as Bootstrap;

const bridge: DesktopBridge = {
  os: process.platform,
  backend: {
    httpBaseUrl: bootstrap.httpBaseUrl,
    wsBaseUrl: bootstrap.wsBaseUrl,
    token: bootstrap.token,
  },
  status: {
    initial: bootstrap.status,
    subscribe: (listener) => {
      const handler = (_event: unknown, status: BackendStatus): void => listener(status);
      ipcRenderer.on("vibest:backend-status", handler);
      return () => {
        ipcRenderer.removeListener("vibest:backend-status", handler);
      };
    },
    retry: () => ipcRenderer.send("vibest:retry"),
    quit: () => ipcRenderer.send("vibest:quit"),
  },
};

contextBridge.exposeInMainWorld("vibest", bridge);
