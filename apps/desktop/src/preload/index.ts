import { contextBridge, ipcRenderer } from "electron";

import type { BackendConnection, DesktopBridge } from "../shared/bridge";

// Synchronous on purpose: the renderer's first module needs the backend's
// origin and token, and the main process already has both by the time this
// window exists (it awaits the backend before creating the window).
const backend = ipcRenderer.sendSync("vibest:bootstrap") as BackendConnection;

const bridge: DesktopBridge = {
  os: process.platform,
  backend,
};

contextBridge.exposeInMainWorld("vibest", bridge);
