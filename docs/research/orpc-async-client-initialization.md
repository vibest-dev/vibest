# oRPC async client initialization

## Question

How should the shared React app and Electron renderer initialize oRPC when the desktop server does not have a port yet?

## Primary-source findings

1. **Creating an oRPC client is synchronous; opening its WebSocket does not have to be.** `createORPCClient` receives a link immediately, while the WebSocket adapter accepts an asynchronous `connect` callback. This permits early client creation, but does not require it; Vibest waits for the initial resolved server descriptor, then creates one stable client.
   - [oRPC client at v2.0.0-beta.16](https://github.com/dinwwwh/orpc/blob/77f62470/packages/client/src/client.ts)
   - [oRPC WebSocket transport at v2.0.0-beta.16](https://github.com/dinwwwh/orpc/blob/77f62470/packages/client/src/adapters/websocket/transport.ts)

2. **The WebSocket adapter is lazy by default.** `connectOnInit` defaults to false. Vibest passes the resolved server URL when it creates the client, while single-use ticket minting stays in `connect` so every reconnect receives a fresh ticket. The same client carries queries, mutations, and event iterators over the multiplexed connection.
   - [oRPC WebSocket adapter documentation](https://orpc.dev/docs/adapters/websocket#client-adapters)

3. **The MessagePort adapter requires a concrete port.** Unlike Fetch and WebSocket, its transport options contain a direct `port` value. Electron's one-time port handoff and the first local-server connection are therefore separate UI resources with separate Suspense boundaries.
   - [oRPC MessagePort transport at v2.0.0-beta.16](https://github.com/dinwwwh/orpc/blob/77f62470/packages/client/src/adapters/message-port/transport.ts)
   - [oRPC MessagePort adapter documentation](https://orpc.dev/docs/adapters/message-port)

4. **`DynamicLink` can asynchronously resolve another link**, but it is unnecessary when the WebSocket adapter already exposes the required asynchronous `connect` option. Its native option keeps one stable client without adding a second dispatch layer.
   - [oRPC DynamicLink at v2.0.0-beta.16](https://github.com/dinwwwh/orpc/blob/77f62470/packages/client/src/dynamic-link.ts)
   - [oRPC DynamicLink documentation](https://orpc.dev/docs/client/dynamic-link)

5. **React can own the pending MessagePort UI.** React 19's `use` can read a stable promise and suspend to the nearest `Suspense` boundary; rejected promises are handled by an Error Boundary. The promise should be created outside the component so it remains stable across renders.
   - [React `use`](https://react.dev/reference/react/use)
   - [React `Suspense`](https://react.dev/reference/react/Suspense)

## Applied model

- Electron Main constructs `LocalServer` immediately with status `starting`; login-shell environment resolution, process spawn, and port readiness run in its supervised fiber.
- Desktop `bootstrap` returns only immediately available shell facts and the status revision cursor.
- A separate `server.connection` oRPC procedure waits for the first successful server connection.
- The BrowserWindow and React startup shell render immediately. `Suspense` owns the MessagePort/bootstrap wait and a nested boundary owns the first server connection wait.
- Server lifecycle UI stays outside the suspended `AppInterface`, so an initial terminal failure can still show Retry/Quit while `server.connection` remains pending. A successful retry resolves the original connection promise.
- `AppInterface` mounts only after receiving a resolved server descriptor, then creates one stable WebSocket oRPC client for queries, mutations, and streams. Desktop HTTP is used only to mint a single-use ticket for each WebSocket connection attempt.
- Runtime crashes keep the app mounted. The supervisor restarts on the pinned port, the lifecycle overlay reports reconnecting/failed states, and the existing WebSocket client reconnects without rebuilding Query, router, or chat ownership.

## Rejected approaches

- **Wait for the server port before creating the BrowserWindow:** a slow shell environment, migration, or process failure would leave the user without a window or React-owned recovery UI.
- **Mount the full application before the first connection:** the starting overlay already blocks all interaction, while lazy server resolution complicates Platform and client construction without visible benefit.
- **Recreate clients after runtime recovery:** changes Query/router/chat dependencies and risks splitting caches or live session ownership.
- **Wrap the WebSocket transport in `DynamicLink`:** valid, but unnecessary when the app receives a resolved initial server and the WebSocket adapter already reconnects lazily.
