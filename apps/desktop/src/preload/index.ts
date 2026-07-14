import { ipcRenderer } from "electron";

import { DESKTOP_PORT_CHANNEL } from "../shared/desktop-channel";

ipcRenderer.once(DESKTOP_PORT_CHANNEL, (event) => {
  const [port] = event.ports;
  if (!port) return;

  window.postMessage({ type: DESKTOP_PORT_CHANNEL }, "*", [port]);
});
