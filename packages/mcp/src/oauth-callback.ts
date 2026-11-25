import http from "node:http"

import { Effect, Predicate } from "effect"

export interface LoopbackOptions {
  readonly redirectPath: string
  readonly requestedPort: number
  readonly expectedState: string
  readonly onCallback: (code: string, iss: string | undefined) => Effect.Effect<void, { readonly message: string }>
}

export interface LoopbackHandle {
  readonly port: number
  readonly close: () => void
}

export const startLoopbackListener = (options: LoopbackOptions): Effect.Effect<LoopbackHandle | undefined> =>
  Effect.tryPromise({
    try: () =>
      new Promise<LoopbackHandle>((resolve, reject) => {
        const srv = http.createServer((req, res) => {
          const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1")

          if (reqUrl.pathname !== options.redirectPath) {
            res.writeHead(404).end("Not found")

            return
          }

          const errorParam = reqUrl.searchParams.get("error_description") ?? reqUrl.searchParams.get("error")

          if (errorParam) {
            res.writeHead(400).end(`OAuth error: ${errorParam}`)

            return
          }

          const returnedState = reqUrl.searchParams.get("state")
          const code = reqUrl.searchParams.get("code")

          if (returnedState !== options.expectedState || !code) {
            res.writeHead(400).end("Invalid OAuth state or missing code")

            return
          }

          Effect.runPromise(
            options.onCallback(code, reqUrl.searchParams.get("iss") ?? undefined).pipe(
              Effect.match({
                onFailure: (error) => {
                  res.writeHead(400, { "content-type": "text/plain" }).end(`Authorization failed: ${error.message}`)
                },
                onSuccess: () => {
                  res
                    .writeHead(200, { "content-type": "text/plain" })
                    .end("Authorization complete. You may close this tab.")
                },
              }),
            ),
          )
        })

        srv.once("error", reject)
        srv.listen(options.requestedPort, "127.0.0.1", () => {
          const addr = srv.address()

          if (addr && !Predicate.isString(addr)) {
            resolve({
              port: addr.port,
              close: () => {
                srv.close()
              },
            })
          } else {
            srv.close()
            reject(new Error("Failed to bind loopback callback server"))
          }
        })
      }),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))
