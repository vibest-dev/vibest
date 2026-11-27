import { HttpConnector } from "@vibest/client/client"
import { CodeMode, type BuiltinToolsProvider } from "@vibest/core/codemode"
import type { CodeModeTool } from "@vibest/core/codemode/mcp-bridge"
import { PlatformNode } from "@vibest/core/effect/platform"
import { VibestApi } from "@vibest/protocol/api"
import { PROTOCOL_HEADER } from "@vibest/protocol/protocol"
import { Json } from "@vibest/schema/json"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import { LayerNode } from "@vibest/util/layer-node"
import { Effect, FileSystem, Layer, Option, Path, Predicate, type Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import { OpenApi } from "effect/http-api"

export * as VibestApiTools from "./vibest-api-tools.ts"

export const VIBEST_NAMESPACE = "vibest"

export const ALLOWED_READ_ONLY_VIBEST_OPERATIONS: ReadonlySet<string> = new Set([
  "daemon.ping",
  "daemon.concurrency",
  "project.info",
  "project.search",
  "session.list",
  "session.get",
  "session.peek",
  "worktree.list",
  "agent.list",
  "agent.outdated",
  "harness.list",
  "runtime.doctor",
  "plugin.list",
  "subscription.list",
  "machine.list",
  "machine.load",
  "mcp.list",
  "mcp.tools",
  "mcp.search",
  "mcp.describe",
  "mcp.events",
  "mcp.skills",
  "mcp.read",
  "codemode.declarations",
  "automation.list",
  "automation.get",
])

export const DEFAULT_VIBEST_API_OPERATIONS: ReadonlyArray<string> = [
  "project.info",
  "project.search",
  "session.list",
  "session.get",
  "session.peek",
  "agent.list",
  "harness.list",
  "automation.list",
  "automation.get",
  "mcp.list",
  "mcp.skills",
  "mcp.read",
]

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH"

const HTTP_METHODS: ReadonlyArray<readonly [string, HttpMethod]> = [
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["delete", "DELETE"],
  ["patch", "PATCH"],
]

interface ParamPlan {
  readonly name: string
  readonly required: boolean
}

interface OperationPlan {
  readonly toolName: string
  readonly operationId: string
  readonly method: HttpMethod
  readonly routePath: string
  readonly pathParams: ReadonlyArray<ParamPlan>
  readonly queryParams: ReadonlyArray<ParamPlan>
  readonly hasJsonBody: boolean
  readonly description?: string | undefined
  readonly inputSchema: Schema.JsonObject
}

const { isJsonObject, parseJsonOption } = Json

const dereferenceSchema = (
  raw: Schema.Json | undefined,
  components: Schema.JsonObject,
  seen: ReadonlySet<string> = new Set(),
): Schema.JsonObject => {
  if (!isJsonObject(raw)) return {}

  if (Predicate.isString(raw.$ref) && raw.$ref.startsWith("#/components/schemas/")) {
    const refName = raw.$ref.slice("#/components/schemas/".length)

    if (seen.has(refName)) return {}
    const target = components[refName]

    if (!isJsonObject(target)) return {}
    const nextSeen = new Set(seen)
    nextSeen.add(refName)

    return dereferenceSchema(target, components, nextSeen)
  }

  const out: Record<string, Schema.Json> = {}

  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue

    if (key === "properties" && isJsonObject(value)) {
      const props: Record<string, Schema.Json> = {}

      for (const [propKey, propVal] of Object.entries(value)) {
        props[propKey] = dereferenceSchema(propVal, components, seen)
      }

      out.properties = props
      continue
    }

    if (key === "items" && isJsonObject(value)) {
      out.items = dereferenceSchema(value, components, seen)
      continue
    }

    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      out[key] = value.map((item) => dereferenceSchema(item, components, seen))
      continue
    }

    out[key] = value
  }

  return out
}

const readConfiguredAllowlist = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
): Effect.Effect<ReadonlySet<string>> =>
  Effect.gen(function* () {
    const configPath = path.join(home, "vibest.json")
    const raw = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => undefined))

    if (raw === undefined) return new Set(DEFAULT_VIBEST_API_OPERATIONS)

    const decoded = parseJsonOption(raw)

    if (Option.isNone(decoded) || !isJsonObject(decoded.value) || !isJsonObject(decoded.value.codemode)) {
      return new Set(DEFAULT_VIBEST_API_OPERATIONS)
    }

    const setting = decoded.value.codemode.vibest

    if (setting === false) return new Set()

    if (Array.isArray(setting)) {
      const filtered = new Set<string>()

      for (const entry of setting) {
        if (!Predicate.isString(entry)) continue

        if (!ALLOWED_READ_ONLY_VIBEST_OPERATIONS.has(entry)) {
          yield* Effect.logWarning("ignoring non-read-only operation in codemode.vibest allowlist", {
            operationId: entry,
          })
          continue
        }

        filtered.add(entry)
      }

      return filtered
    }

    return new Set(DEFAULT_VIBEST_API_OPERATIONS)
  })

const compileAllReadOnlyPlans = (): ReadonlyArray<OperationPlan> => {
  const decodedSpec = parseJsonOption(JSON.stringify(OpenApi.fromApi(VibestApi)))

  if (Option.isNone(decodedSpec) || !isJsonObject(decodedSpec.value) || !isJsonObject(decodedSpec.value.paths)) {
    return []
  }

  const componentsObj = decodedSpec.value.components
  const schemasObj = isJsonObject(componentsObj) ? componentsObj.schemas : undefined
  const components: Schema.JsonObject = isJsonObject(schemasObj) ? schemasObj : {}
  const plans: Array<OperationPlan> = []

  for (const [routePath, pathItem] of Object.entries(decodedSpec.value.paths)) {
    if (!isJsonObject(pathItem)) continue

    for (const [methodKey, method] of HTTP_METHODS) {
      const op = pathItem[methodKey]

      if (
        !isJsonObject(op) ||
        !Predicate.isString(op.operationId) ||
        !ALLOWED_READ_ONLY_VIBEST_OPERATIONS.has(op.operationId) ||
        (method !== "GET" && op.operationId !== "mcp.read")
      ) {
        continue
      }

      const pathParams: Array<ParamPlan> = []
      const queryParams: Array<ParamPlan> = []
      const properties: Record<string, Schema.Json> = {}
      const required: Array<string> = []

      if (Array.isArray(op.parameters)) {
        for (const param of op.parameters) {
          if (!isJsonObject(param) || !Predicate.isString(param.name) || !Predicate.isString(param.in)) continue

          if (param.in !== "path" && param.in !== "query") continue
          const isReq = param.required === true || param.in === "path"

          if (param.in === "path") pathParams.push({ name: param.name, required: isReq })
          else queryParams.push({ name: param.name, required: isReq })

          const paramSchema = dereferenceSchema(param.schema, components)

          if (Predicate.isString(param.description) && paramSchema.description === undefined) {
            properties[param.name] = { ...paramSchema, description: param.description }
          } else {
            properties[param.name] = paramSchema
          }

          if (isReq && !required.includes(param.name)) required.push(param.name)
        }
      }

      let hasJsonBody = false

      if (
        isJsonObject(op.requestBody) &&
        isJsonObject(op.requestBody.content) &&
        isJsonObject(op.requestBody.content["application/json"])
      ) {
        const bodySchema = dereferenceSchema(op.requestBody.content["application/json"].schema, components)
        hasJsonBody = true

        if (isJsonObject(bodySchema.properties)) {
          for (const [key, propSchema] of Object.entries(bodySchema.properties)) {
            if (propSchema !== undefined && !(key in properties)) {
              properties[key] = propSchema
            }
          }
        }

        if (Array.isArray(bodySchema.required)) {
          for (const key of bodySchema.required) {
            if (Predicate.isString(key) && !required.includes(key)) required.push(key)
          }
        }
      }

      const description = Predicate.isString(op.summary)
        ? op.summary
        : Predicate.isString(op.description)
          ? op.description
          : undefined

      const inputSchema: Schema.JsonObject = {
        type: "object",
        properties,
        ...(required.length > 0 && { required }),
      }

      plans.push({
        toolName: op.operationId.replaceAll(".", "_"),
        operationId: op.operationId,
        method,
        routePath,
        pathParams,
        queryParams,
        hasJsonBody,
        ...(description !== undefined && { description }),
        inputSchema,
      })
    }
  }

  return plans.toSorted((a, b) => a.toolName.localeCompare(b.toolName))
}

const ALL_READ_ONLY_PLANS: ReadonlyArray<OperationPlan> = compileAllReadOnlyPlans()

const buildOperationPlans = (allowlist: ReadonlySet<string>): ReadonlyArray<OperationPlan> =>
  allowlist.size === 0 ? [] : ALL_READ_ONLY_PLANS.filter((plan) => allowlist.has(plan.operationId))

const formatHttpError = (status: number, text: string): string => {
  const parsed = parseJsonOption(text)

  if (Option.isSome(parsed) && isJsonObject(parsed.value) && Predicate.isString(parsed.value.message)) {
    return parsed.value.message
  }

  const trimmed = text.trim()

  return trimmed.length > 0 ? trimmed : `HTTP ${status}`
}

export const httpConnectorNode = LayerNode.unbound(HttpConnector.Service)

export const make = Effect.fn("VibestApiTools.make")(function* (): Effect.fn.Return<
  BuiltinToolsProvider,
  never,
  Layout | FileSystem.FileSystem | Path.Path | HttpConnector.Service
> {
  const layout = yield* Layout
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const makeHttp = yield* HttpConnector.Service
  const httpClient = makeHttp(layout.socket)
  const allowlist = yield* readConfiguredAllowlist(fs, path, layout.home)
  const plans = buildOperationPlans(allowlist)
  const plansByName = new Map(plans.map((plan) => [plan.toolName, plan]))

  const execute: BuiltinToolsProvider["execute"] = ({ tool, args, headers }) =>
    Effect.gen(function* () {
      const plan = plansByName.get(tool)

      if (!plan) {
        return yield* Effect.fail({ message: `Unknown built-in tool "${VIBEST_NAMESPACE}.${tool}"` })
      }

      const argsObj = isJsonObject(args) ? args : {}
      let resolvedPath = plan.routePath
      const consumedKeys = new Set<string>()

      for (const param of plan.pathParams) {
        const value = argsObj[param.name]

        if (value === undefined || value === null) {
          return yield* Effect.fail({
            message: `tools.${VIBEST_NAMESPACE}.${tool} requires parameter "${param.name}"`,
          })
        }

        consumedKeys.add(param.name)
        resolvedPath = resolvedPath.replaceAll(`{${param.name}}`, encodeURIComponent(String(value)))
      }

      const queryParts: Array<string> = []

      for (const param of plan.queryParams) {
        const value = argsObj[param.name]

        if (value === undefined || value === null) {
          if (param.required) {
            return yield* Effect.fail({
              message: `tools.${VIBEST_NAMESPACE}.${tool} requires parameter "${param.name}"`,
            })
          }

          continue
        }

        consumedKeys.add(param.name)
        queryParts.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(String(value))}`)
      }

      const queryString = queryParts.join("&")
      const url = `http://localhost${resolvedPath}${queryString.length > 0 ? `?${queryString}` : ""}`

      const baseHeaders: Record<string, string> =
        headers !== undefined && Object.keys(headers).length > 0
          ? { [PROTOCOL_HEADER]: String(PROTOCOL), ...headers }
          : { [PROTOCOL_HEADER]: String(PROTOCOL) }

      let req = HttpClientRequest.make(plan.method)(url).pipe(HttpClientRequest.setHeaders(baseHeaders))

      if (plan.hasJsonBody) {
        const body: Record<string, Schema.Json> = {}

        for (const [key, value] of Object.entries(argsObj)) {
          if (!consumedKeys.has(key) && value !== undefined) {
            body[key] = value
          }
        }

        req = HttpClientRequest.bodyJsonUnsafe(req, body)
      }

      const response = yield* httpClient.execute(req).pipe(Effect.mapError((error) => ({ message: error.message })))

      const text = yield* response.text.pipe(Effect.mapError((error) => ({ message: error.message })))

      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail({ message: formatHttpError(response.status, text) })
      }

      if (response.status === 204 || text.trim().length === 0) {
        return undefined
      }

      const decoded = parseJsonOption(text)

      return Option.isSome(decoded) ? decoded.value : text
    })

  const list = (): ReadonlyArray<CodeModeTool> =>
    plans.map((plan) => ({
      server: VIBEST_NAMESPACE,
      name: plan.toolName,
      ...(plan.description !== undefined && { description: plan.description }),
      inputSchema: plan.inputSchema,
      execute: (args) => execute({ tool: plan.toolName, args }),
    }))

  return {
    namespace: VIBEST_NAMESPACE,
    list,
    execute,
  }
})

export const layer = Layer.effect(CodeMode.BuiltinTools, make())

export const node = LayerNode.make({
  service: CodeMode.BuiltinTools,
  layer,
  deps: [PlatformNode.layout, PlatformNode.fileSystem, PlatformNode.path, httpConnectorNode],
})
