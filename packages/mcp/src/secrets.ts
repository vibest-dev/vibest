import crypto from "node:crypto"

import type { Mcp } from "@vibest/schema/mcp"
import { Duration, Effect, Option, Predicate, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { SecretResolutionError } from "./errors.ts"

export * as McpSecrets from "./secrets.ts"

const COMMAND_TIMEOUT = Duration.seconds(10)
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024

export const isCommandSecret = (value: string): boolean => value.startsWith("!") && !value.startsWith("!!")

const unescapeLiteral = (value: string): string => (value.startsWith("!!") ? value.slice(1) : value)

const shellCommandFor = (command: string): readonly [string, ReadonlyArray<string>] =>
  process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", command]] : ["/bin/sh", ["-c", command]]

const runSecretCommand = (
  command: string,
  context: string,
): Effect.Effect<string, SecretResolutionError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const [bin, args] = shellCommandFor(command)

    const program = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(bin, [...args], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "ignore",
              detached: process.platform !== "win32",
              forceKillAfter: Duration.seconds(1),
            }),
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new SecretResolutionError({
                  context,
                  message: `secret command failed to start: ${error.message}`,
                }),
            ),
          )

        const chunks: Array<Uint8Array> = []
        let totalBytes = 0

        yield* handle.stdout.pipe(
          Stream.runForEach((chunk) =>
            Effect.suspend(() => {
              totalBytes += chunk.byteLength

              if (totalBytes > COMMAND_MAX_OUTPUT_BYTES) {
                return handle.kill({ killSignal: "SIGKILL" }).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.fail(
                      new SecretResolutionError({
                        context,
                        message: "secret command output exceeded 1 MiB",
                      }),
                    ),
                  ),
                )
              }

              chunks.push(chunk)

              return Effect.void
            }),
          ),
          Effect.mapError((error) =>
            error instanceof SecretResolutionError
              ? error
              : new SecretResolutionError({ context, message: error.message }),
          ),
        )

        const code = yield* handle.exitCode.pipe(
          Effect.mapError((error) => new SecretResolutionError({ context, message: error.message })),
        )

        if (Number(code) !== 0) {
          return yield* new SecretResolutionError({
            context,
            message: `secret command exited with code ${code}`,
          })
        }

        const resolved = Buffer.concat(chunks, totalBytes).toString("utf8").trim()

        if (resolved.length === 0) {
          return yield* new SecretResolutionError({
            context,
            message: "secret command returned empty output",
          })
        }

        return resolved
      }),
    )

    const result = yield* program.pipe(Effect.timeoutOption(COMMAND_TIMEOUT))

    if (Option.isNone(result)) {
      return yield* new SecretResolutionError({
        context,
        message: `secret command timed out after ${Duration.toMillis(COMMAND_TIMEOUT)}ms`,
      })
    }

    return result.value
  })

export const resolveValue = Effect.fn("McpSecrets.resolveValue")(function* (
  value: string,
  context: string,
): Effect.fn.Return<string, SecretResolutionError, ChildProcessSpawner.ChildProcessSpawner> {
  if (!isCommandSecret(value)) return unescapeLiteral(value)

  return yield* runSecretCommand(value.slice(1), context)
})

export const resolveRecord = Effect.fn("McpSecrets.resolveRecord")(function* (
  record: Readonly<Record<string, string>> | undefined,
  contextPrefix: string,
): Effect.fn.Return<
  Record<string, string> | undefined,
  SecretResolutionError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  if (record === undefined) return undefined
  const resolved: Record<string, string> = {}

  for (const [key, value] of Object.entries(record)) {
    resolved[key] = yield* resolveValue(value, `${contextPrefix}.${key}`)
  }

  return resolved
})

export const resolveServerConfig = Effect.fn("McpSecrets.resolveServerConfig")(function* (
  server: string,
  config: Mcp.ServerConfig,
): Effect.fn.Return<Mcp.ServerConfig, SecretResolutionError, ChildProcessSpawner.ChildProcessSpawner> {
  if (config.type === "local") {
    const environment = yield* resolveRecord(config.environment, `${server}.environment`)

    return { ...config, ...(environment !== undefined && { environment }) }
  }

  const headers = yield* resolveRecord(config.headers, `${server}.headers`)

  const bearerToken =
    config.bearerToken !== undefined ? yield* resolveValue(config.bearerToken, `${server}.bearerToken`) : undefined

  if (config.oauth && config.oauth.clientSecret !== undefined) {
    const clientSecret = yield* resolveValue(config.oauth.clientSecret, `${server}.oauth.clientSecret`)

    return {
      ...config,
      ...(headers !== undefined && { headers }),
      ...(bearerToken !== undefined && { bearerToken }),
      oauth: { ...config.oauth, clientSecret },
    }
  }

  return {
    ...config,
    ...(headers !== undefined && { headers }),
    ...(bearerToken !== undefined && { bearerToken }),
  }
})

export const fingerprintSecret = (value: string | Readonly<Record<string, string>> | undefined): string | null => {
  if (value === undefined) return null

  const serialized = Predicate.isString(value)
    ? value
    : JSON.stringify(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)))

  return crypto.createHash("sha256").update(serialized, "utf8").digest("hex")
}
