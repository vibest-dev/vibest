# Stack quirks

These differ from what the library names suggest.

- **Effect is 4.x beta, not v3.** `Schema` imports from `"effect"` (not
  `@effect/schema`); services are `Context.Service<Self, Shape>()("Tag")` with a
  hand-written `Layer`, not `Effect.Service`. Two experimental modules are in
  production use: `effect/unstable/cli` and `effect/unstable/process`.
- **oRPC is a locked beta and the transport is WebSocket**, not HTTP: one
  multiplexed connection via `@orpc/client/websocket`, with a lazy `connect`
  factory so each reconnect fetches a fresh ticket (browsers can't set headers on
  a WS upgrade, hence `POST /api/ws-ticket`). Server handlers are Effect-native
  through a side-effect import — `import "@orpc/experimental-effect/extensions/effect"`
  is what puts `.effect()` on procedures; delete it and the router stops compiling.
  Effect `Stream` → oRPC event iterator has one seam: `packages/server/src/rpc/stream.ts`.
- **`@vibest/contract` uses Effect Schema, not zod**, bridged through a local
  `toStandardSchema`. Chunk/message-shaped outputs deliberately use `type<T>()`
  and are not validated on the wire.
- **`packages/ui` sits on Base UI, not Radix** — compose with `render={<Button/>}`,
  not `asChild`.
- **TypeScript is 7.x, the native compiler.** `noEmit` everywhere; packages export
  `./src/*.ts` directly and only `server` and `vibest` build. `lib` is `es2022`,
  so `toSorted`/`toSpliced` don't typecheck — write `Array.from(list).sort()`.
  `noUncheckedIndexedAccess` is on, so indexed access yields `T | undefined`.
