import childProcess from "node:child_process"
import crypto from "node:crypto"

import type { Mcp } from "@vibest/schema/mcp"
import { Effect, Predicate } from "effect"

import { SecretResolutionError } from "./errors.ts"

export * as McpSecrets from "./secrets.ts"

const COMMAND_TIMEOUT_MS = 10_000
const COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024
const USE_PROCESS_GROUP = process.platform !== "win32"

export const isCommandSecret = (value: string): boolean => value.startsWith("!") && !value.startsWith("!!")

const unescapeLiteral = (value: string): string => (value.startsWith("!!") ? value.slice(1) : value)

const runSecretCommand = (command: string, context: string): Effect.Effect<string, SecretResolutionError> =>
  Effect.callback<string, SecretResolutionError>((resume) => {
    let output = Buffer.alloc(0)
    let settled = false

    const child = childProcess.spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      detached: USE_PROCESS_GROUP,
    })

    const killChild = () => {
      if (child.pid === undefined) return

      if (USE_PROCESS_GROUP) {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          return
        }

        return
      }

      try {
        child.kill("SIGKILL")
      } catch {
        return
      }
    }

    const finishError = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resume(Effect.fail(new SecretResolutionError({ context, message })))
    }

    const finishSuccess = (value: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resume(Effect.succeed(value))
    }

    const timer = setTimeout(() => {
      killChild()
      finishError(`secret command timed out after ${COMMAND_TIMEOUT_MS}ms`)
    }, COMMAND_TIMEOUT_MS)

    child.on("error", (error) => {
      finishError(`secret command failed to start: ${error.message}`)
    })

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return
      output = Buffer.concat([output, Buffer.from(chunk)])

      if (output.byteLength > COMMAND_MAX_OUTPUT_BYTES) {
        killChild()
        finishError("secret command output exceeded 1 MiB")
      }
    })

    child.on("close", (code) => {
      if (settled) return

      if (code !== 0) {
        finishError(`secret command exited with code ${code ?? "unknown"}`)

        return
      }

      const resolved = output.toString("utf8").trim()

      if (resolved.length === 0) {
        finishError("secret command returned empty output")

        return
      }

      finishSuccess(resolved)
    })

    return Effect.sync(() => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        killChild()
      }
    })
  })

export const resolveValue = Effect.fn("McpSecrets.resolveValue")(function* (
  value: string,
  context: string,
): Effect.fn.Return<string, SecretResolutionError> {
  if (!isCommandSecret(value)) return unescapeLiteral(value)

  return yield* runSecretCommand(value.slice(1), context)
})

export const resolveRecord = Effect.fn("McpSecrets.resolveRecord")(function* (
  record: Readonly<Record<string, string>> | undefined,
  contextPrefix: string,
): Effect.fn.Return<Record<string, string> | undefined, SecretResolutionError> {
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
): Effect.fn.Return<Mcp.ServerConfig, SecretResolutionError> {
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
