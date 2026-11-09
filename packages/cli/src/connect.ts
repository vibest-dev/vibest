import net from "node:net"

import { Effect, Schema } from "effect"

export class ConnectFailed extends Schema.TaggedError<ConnectFailed>()("ConnectFailed", { message: Schema.String }) {}

type Stdio = { readonly stdin: NodeJS.ReadableStream; readonly stdout: NodeJS.WritableStream }

export const pipeStdio = (socket: string, io: Stdio = process) =>
  Effect.callback<void, ConnectFailed>((resume) => {
    const conn = net.createConnection(socket)
    let failure: Error | undefined
    conn.on("error", (error) => (failure = error))
    conn.on("close", () =>
      resume(failure === undefined ? Effect.void : Effect.fail(new ConnectFailed({ message: failure.message }))),
    )
    io.stdin.on("end", () => conn.end())
    io.stdin.pipe(conn)
    conn.pipe(io.stdout)
  })
