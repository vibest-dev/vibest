import { callerTarget, filterCallerEnv } from "@vibest/core/caller"
import { Db } from "@vibest/core/db"
import { Plugins } from "@vibest/core/plugins"
import { locateProject, resolveProject } from "@vibest/core/project-identity"
import { Runtimes } from "@vibest/core/runtimes"
import { NotInRepository } from "@vibest/core/worktree"
import { type ACCESS, Caller, type CallerShape, Forbidden, VibestRpcs } from "@vibest/protocol/rpc"
import { Effect } from "effect"
import type { RpcGroup } from "effect/rpc"

type Access = typeof ACCESS
type Allowed<K extends keyof Access> = Access[K] extends readonly unknown[] ? Access[K][number] : Access[K]
export type MethodOf<A> = {
  [K in keyof Access]: [Extract<Allowed<K>, A>] extends [never] ? never : K
}[keyof Access]

export type Handlers = Partial<RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof VibestRpcs>>>

export type Agent = Extract<CallerShape, { _tag: "Cli" | "Session" }>

export const make = Effect.gen(function* () {
  const db = yield* Db
  const plugins = yield* Plugins
  const runtimes = yield* Runtimes

  const agent = (method: MethodOf<"agent" | "owner">) =>
    Effect.gen(function* () {
      const c = yield* Caller
      if (c._tag === "Cli" || c._tag === "Session") return c
      return yield* new Forbidden({
        method,
        message: `only the user or a session calls ${method}`,
      })
    })

  const atProject = (directory: string) =>
    locateProject(directory).pipe(
      Effect.catchIf(
        (error) => error._tag !== "NotInRepository",
        (error) => Effect.die(error),
      ),
    )
  const resolveAt = (directory: string) => atProject(directory).pipe(Effect.flatMap((at) => resolveProject(db, at)))
  const findAt = (directory: string) => atProject(directory).pipe(Effect.flatMap((at) => db.projectAt(at.root)))

  const projectOf = (c: Agent, method: string) =>
    Effect.gen(function* () {
      if (c._tag === "Cli") return yield* resolveAt(c.repositoryRoot)
      const directory = yield* db.projectDirectory(c.projectId)
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

  const machineFromCaller = (input: {
    readonly callerEnv: Readonly<Record<string, string>>
    readonly runtimeSession?: string | undefined
  }) =>
    Effect.gen(function* () {
      const specs = yield* plugins.settled.pipe(Effect.andThen(runtimes.callers))
      const target = callerTarget(specs, filterCallerEnv(specs, input.callerEnv), input.runtimeSession)
      return { id: "local", ...(target !== undefined ? { target } : {}) }
    })

  const cliOnly = (method: MethodOf<"cli">) =>
    Effect.flatMap(Caller, (c) =>
      c._tag === "Cli"
        ? Effect.succeed(c)
        : Effect.fail(new Forbidden({ method, message: `only the user runs ${method}` })),
    )

  const self = (method: MethodOf<"self">, id: string) =>
    Effect.gen(function* () {
      const c = yield* Caller
      if (c._tag === "Session" && c.sessionId === id) return undefined
      return yield* new Forbidden({ method, message: `${method} ${id} runs only in that agent's own terminal` })
    })

  return { agent, atProject, resolveAt, findAt, projectOf, scope, machineFromCaller, cliOnly, self }
})

export type Checks = Effect.Success<typeof make>
