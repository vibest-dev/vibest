import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";

// The renderer posts `orpc:connect` to its own window (see renderer/src/lib/client.ts).
// Packaged builds load the renderer from file://, where `location.origin` can be
// reported as "file://" or as the opaque origin "null"/"", so accept those too.
const TRUSTED_ORIGINS = new Set([window.location.origin, "file://", "null", ""]);

// Forward MessagePort from renderer to main process for oRPC
window.addEventListener("message", (event) => {
  // Only trust messages this window posted to itself: a cross-origin iframe or an
  // opener window can never satisfy `event.source === window`, so it can neither
  // reach the main process nor smuggle a MessagePort through this bridge.
  // The origin allowlist is defense in depth on top of that.
  if (event.source !== window || !TRUSTED_ORIGINS.has(event.origin)) {
    return;
  }

  if (event.data === "orpc:connect" && event.ports[0]) {
    ipcRenderer.postMessage("orpc:connect", null, [event.ports[0]]);
  }
});

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error (define in dts)
  window.electron = electronAPI;
}
