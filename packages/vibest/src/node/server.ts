import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeRPCHandler, createWsRPCHandler } from "@vibest/server-rpc";
import express from "express";
import sirv from "sirv";
import { createServer as createViteDevServer } from "vite";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

const isDev = process.env.NODE_ENV === "development";

export async function createServer(): Promise<Server> {
	const handler = createNodeRPCHandler();
	const wsHandler = createWsRPCHandler();

	const app = express();
	const server = createHttpServer(app);
	const wss = new WebSocketServer({ noServer: true });

	wss.on("connection", (ws) => {
		wsHandler(ws);
	});
	wss.on("error", (e: Error & { code: string; port: number }) => {
		console.error(e);
	});

	app
		.get("/api/health", (_, res) => {
			res.send("ok");
		})
		.use("/api/rpc{/*path}", async (req, res, next) => {
			const { matched } = await handler(req, res, {
				prefix: "/api/rpc",
			});
			if (matched) {
				return;
			}
			next();
		});

	if (isDev) {
		const vite = await createViteDevServer({
			server: {
				middlewareMode: true,
				hmr: {
					server,
				},
			},
		});
		app.use(vite.middlewares);
	} else {
		const staticDir = path.resolve(
			fileURLToPath(new URL("./client/", import.meta.url)),
		);
		app.use(
			sirv(staticDir, {
				single: true,
			}),
		);
	}

	// Share the same HTTP server between Vite's HMR socket and our custom WebSocketServer.
	server.on("upgrade", (req, socket, head) => {
		if (isDev) {
			const protocol = req.headers["sec-websocket-protocol"];
			if (protocol && ["vite-ping", "vite-hmr"].includes(protocol)) return;
		}
		wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
			wss.emit("connection", ws, req);
		});
	});

	return server;
}
