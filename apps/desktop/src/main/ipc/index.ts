import { RPCHandler } from "@orpc/server/message-port";
import { ipcMain } from "electron";

import type { App } from "../app";

import { router } from "./router";

export function setupIPC(app: App): void {
	const handler = new RPCHandler(router);

	ipcMain.on("orpc:connect", (event) => {
		const [serverPort] = event.ports;
		handler.upgrade(serverPort, { context: { app } });
		serverPort.start();
	});
}
