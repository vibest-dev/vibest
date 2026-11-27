import { type AgentMcpScope, mcpDisallowedMessage, sessionMcpScope } from "@vibest/core/agent/mcp-scope"
import { Agents } from "@vibest/core/agent/registry"
import { callerTarget, filterCallerEnv } from "@vibest/core/caller"
import { locateProject, resolveProject } from "@vibest/core/project/identity"
import { ProjectStore } from "@vibest/core/project/store"
import { Runtimes } from "@vibest/core/runtime/registry"
import { SessionStore } from "@vibest/core/session/store"
import { Git } from "@vibest/core/worktree/git"
import type { ACCESS } from "@vibest/protocol/access"
import { Forbidden } from "@vibest/protocol/errors"
import { Caller, type CallerIdentity } from "@vibest/protocol/middleware"
import { NotInRepository } from "@vibest/schema/session"
import { Context, Effect, FileSystem, Layer, Option, Path, Predicate } from "effect"

type Access = typeof ACCESS

type Allowed<K extends keyof Access> = Access[K] extends readonly unknown[] ? Access[K][number] : Access[K]

export type MethodOf<A> = {
  [K in keyof Access]: [Extract<Allowed<K>, A>] extends [never] ? never : K
}[keyof Access]

export type Agent = Extract<CallerIdentity, { _tag: "Cli" | "Ui" | "Session" }>

export const make = Effect.gen(function* () {
  const projectStore = yield* ProjectStore.Service
  const sessionStore = yield* SessionStore.Service
  const agents = yield* Agents.Service
  const runtimes = yield* Runtimes.Service
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const git = yield* Git.Service

  const agent = (method: MethodOf<"agent" | "owner">) =>
    Effect.gen(function* () {
      const c = yield* Caller

      if (Predicate.isTagged(c, "Cli") || Predicate.isTagged(c, "Ui") || Predicate.isTagged(c, "Session")) return c

      return yield* new Forbidden({
        method,
        message: `only the user or a session calls ${method}`,
      })
    })

  const atProject = (directory: string) =>
    locateProject(directory).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Git.Service, git),
      Effect.catchIf(
        (error) => !Predicate.isTagged(error, "NotInRepository"),
        (error) => Effect.die(error),
      ),
    )

  const resolveAt = (directory: string) =>
    atProject(directory).pipe(Effect.flatMap((at) => resolveProject(projectStore, at)))

  const findAt = (directory: string) =>
    atProject(directory).pipe(Effect.flatMap((at) => projectStore.projectAt(at.root)))

  const projectOf = (c: Agent, method: string) =>
    Effect.gen(function* () {
      if (Predicate.isTagged(c, "Cli")) return yield* resolveAt(c.repositoryRoot)

      if (!Predicate.isTagged(c, "Session"))
        return yield* new Forbidden({ method, message: `${method} needs a project` })
      const directory = yield* projectStore.projectDirectory(c.projectId)

      if (directory !== undefined) return { id: c.projectId, directory }

      if (c.repositoryRoot === undefined) return yield* new NotInRepository({ path: `project ${c.projectId}` })
      const here = yield* resolveAt(c.repositoryRoot)

      if (here.id !== c.projectId)
        return yield* new Forbidden({
          method,
          message:
            "a session only works in its own project: cd into the directory where vibest was started and run it again",
        })

      return here
    })

  const scope = (method: MethodOf<"agent">) => agent(method).pipe(Effect.flatMap((c) => projectOf(c, method)))

  const machineFromCaller = (
    method: "session.launch" | "session.spawn",
    input: {
      readonly callerEnv: Readonly<Record<string, string>>
      readonly runtime?: string | undefined
      readonly runtimeSession?: string | undefined
    },
  ) =>
    Effect.gen(function* () {
      const specs = yield* runtimes.callers
      const at = callerTarget(specs, filterCallerEnv(specs, input.callerEnv), input.runtime, input.runtimeSession)

      if ("refused" in at) return yield* new Forbidden({ method, message: at.refused })

      return { id: "local", ...at }
    })

  const cliOnly = (method: MethodOf<"cli">) =>
    Effect.flatMap(Caller, (c) =>
      Predicate.isTagged(c, "Cli")
        ? Effect.succeed(c)
        : Effect.fail(new Forbidden({ method, message: `only the user runs ${method}` })),
    )

  const userOnly = (method: MethodOf<"cli">) =>
    Effect.flatMap(Caller, (c) =>
      Predicate.isTagged(c, "Cli") || Predicate.isTagged(c, "Ui")
        ? Effect.succeed(c)
        : Effect.fail(new Forbidden({ method, message: `only the user runs ${method}` })),
    )

  const self = (method: MethodOf<"self">, id: string) =>
    Effect.gen(function* () {
      const c = yield* Caller

      if (Predicate.isTagged(c, "Session") && c.sessionId === id) return undefined

      return yield* new Forbidden({ method, message: `${method} ${id} runs only in that agent's own terminal` })
    })

  const mcpScope: Effect.Effect<Option.Option<AgentMcpScope>, never, Caller> = Effect.flatMap(Caller, (c) =>
    Predicate.isTagged(c, "Session")
      ? sessionMcpScope(sessionStore, agents, c.sessionId)
      : Effect.succeed(Option.none()),
  )

  const requireMcpServer = (method: string, server: string) =>
    Effect.flatMap(mcpScope, (current) =>
      Option.isSome(current) && !current.value.allowed.has(server)
        ? Effect.fail(
            new Forbidden({
              method,
              message: mcpDisallowedMessage(current.value.agent, server),
            }),
          )
        : Effect.void,
    )

  return {
    agent,
    atProject,
    resolveAt,
    findAt,
    projectOf,
    scope,
    machineFromCaller,
    cliOnly,
    userOnly,
    self,
    mcpScope,
    requireMcpServer,
  }
})

export type Checks = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Checks>()("vibest/CallerChecks") {}

export const layer = Layer.effect(Service, make)
