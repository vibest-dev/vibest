import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";

// Forward MessagePort from renderer to main process for oRPC
window.addEventListener("message", (event) => {
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
