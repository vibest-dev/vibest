import type { PipeClient } from "@vibest/client/pipe"
import { callerKind } from "@vibest/core/caller"
import { Db } from "@vibest/core/database/db"
import type { RemoteScope } from "@vibest/core/database/remote"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { PlatformNode } from "@vibest/core/effect/platform"
import { Git } from "@vibest/core/git"
import { Identity } from "@vibest/core/identity"
import { PluginLoader, pluginLoaderNode } from "@vibest/core/plugin/sources"
import { cloneDestination } from "@vibest/core/project/clone"
import { listProjectRepositories } from "@vibest/core/project/create"
import { locateProject, resolveProject } from "@vibest/core/project/identity"
import { repositoryIdentity } from "@vibest/core/repository-url"
import { Runtimes } from "@vibest/core/runtimes"
import { remoteHeaders } from "@vibest/protocol/protocol"
import type { PayloadOf, SessionInfo } from "@vibest/protocol/rpc"
import { randomId } from "@vibest/schema/id"
import { Layout } from "@vibest/schema/layout"
import { type ListedMachine, MachineFailed, MachineIncompatible } from "@vibest/schema/machine"
import { ProjectCloneFailed } from "@vibest/schema/project"
import { Context, Data, Effect, FileSystem, Layer, Path, Predicate, Stream } from "effect"

import { Machines } from "./machines.ts"

export * as Remote from "./remote.ts"

type Address =
  | { readonly _tag: "Local"; readonly id: string }
  | { readonly _tag: "Remote"; readonly machine: string; readonly id: string }

const Address = Data.taggedEnum<Address>()

export const address = (input: string): Address => {
  const at = input.indexOf("/")

  return at <= 0
    ? Address.Local({ id: input })
    : Address.Remote({ machine: input.slice(0, at), id: input.slice(at + 1) })
}

export type At = Extract<Address, { readonly _tag: "Remote" }>

export type ListScope =
  | { readonly _tag: "All" }
  | { readonly _tag: "Project"; readonly id: string }
  | { readonly _tag: "Nothing" }
  | ({ readonly _tag: "Remote" } & RemoteScope)

export const ListScope = Data.taggedEnum<ListScope>()

type Forwarded<A, E> = (
  client: PipeClient,
  at: At,
  options: { readonly headers: Record<string, string> },
) => Effect.Effect<A, E>

const addressed = (machine: string, id: string) => `${machine}/${id}`

const REFUSED = [
  ["env", "--env"],
  ["share", "--share"],
  ["runtimeSession", "--session"],
] as const

type Away = { readonly machine: ListedMachine; readonly sessions: ReadonlyArray<SessionInfo> }

const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const machines = yield* Machines.Service
  const self = yield* Identity.Service
  const git = yield* Git.Service
  const runtimes = yield* Runtimes.Service
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const layout = yield* Layout
  const loader = yield* PluginLoader

  const provided = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Git.Service>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Git.Service, git),
    )

  const view = <R extends SessionInfo>(name: string, rows: ReadonlyArray<R>) =>
    Effect.map(machines.viewSessions(name, rows), (mapped) =>
      mapped.map((row): R => ({ ...row, id: addressed(name, row.id) })),
    )

  const call = <A, E>(
    machine: string,
    project: string,
    by: string,
    f: (client: PipeClient, headers: Record<string, string>) => Effect.Effect<A, E>,
  ) => Effect.flatMap(machines.link(machine), (link) => link.call(f(link.client, remoteHeaders(self.id, project, by))))

  const relay = Effect.fn("Remote.relay")(<A, E>(at: At, project: string, by: string, f: Forwarded<A, E>) =>
    call(at.machine, project, by, (client, headers) => f(client, at, { headers })),
  )

  return {
    relay,

    forward: Effect.fn("Remote.forward")(
      <A extends { readonly id: string } | null, E>(at: At, project: string, by: string, f: Forwarded<A, E>) =>
        Effect.map(relay(at, project, by, f), (row): A =>
          row === null ? row : { ...row, id: addressed(at.machine, row.id) },
        ),
    ),

    link: Effect.fn("Remote.link")(
      (
        machine: string,
        edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly remote?: string | undefined }>,
      ) =>
        Effect.flatMap(machines.link(machine), (link) =>
          link.call(link.client["Remote.Link"]({ edges }, { headers: remoteHeaders(self.id) })),
        ),
    ),

    unlink: Effect.fn("Remote.unlink")(
      (
        machine: string,
        edges: ReadonlyArray<{ readonly from: string; readonly to: string; readonly remote?: string | undefined }>,
      ) =>
        Effect.flatMap(machines.link(machine), (link) =>
          link.call(link.client["Remote.Unlink"]({ edges }, { headers: remoteHeaders(self.id) })),
        ),
    ),

    harnesses: Effect.fn("Remote.harnesses")((machine: string, provider: string | undefined) =>
      Effect.flatMap(machines.link(machine), (link) =>
        link.call(
          link.client["Harnesses.List"](provider === undefined ? {} : { provider }, {
            headers: remoteHeaders(self.id),
          }),
        ),
      ),
    ),

    clone: (machine: string | undefined, input: { readonly url: string; readonly directory?: string | undefined }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (machine !== undefined) {
            const link = yield* machines.link(machine)

            if (link.capabilities.projectClone !== true)
              return yield* new MachineIncompatible({
                machine,
                message: `${machine} runs a vibest that does not clone projects; run vibest update on ${machine}`,
              })

            return link.stream(
              link.client["Project.Clone"](
                { url: input.url, ...(input.directory !== undefined && { directory: input.directory }) },
                { headers: remoteHeaders(self.id) },
              ),
            )
          }

          const { dest } = yield* cloneDestination(input.url, input.directory).pipe(
            Effect.provideService(Layout, layout),
            Effect.provideService(PluginLoader, loader),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          )

          const failed = (e: { readonly message: string }) =>
            new ProjectCloneFailed({ message: `git clone ${input.url}: ${e.message}` })

          const added = locateProject(dest).pipe(
            provided,
            Effect.flatMap((at) => resolveProject(db, at)),
            Effect.map((project) => ({ projectId: project.id, directory: project.directory })),
            Effect.mapError(failed),
          )

          return Stream.concat(
            Stream.make({ progress: `cloning ${input.url} into ${dest} on ${self.name}` }),
            Stream.concat(
              git.clone(input.url, dest).pipe(
                Stream.map((progress) => ({ progress })),
                Stream.mapError(failed),
              ),
              Stream.fromEffect(added),
            ),
          )
        }),
      ),

    agents: Effect.fn("Remote.agents")(function* (machine: string) {
      const link = yield* machines.link(machine)

      if (link.capabilities.agents !== true)
        return yield* new MachineIncompatible({
          machine,
          message: `${machine} runs a vibest that does not list agents; run vibest update there`,
        })

      return yield* link.call(link.client["Agents.List"]({}, { headers: remoteHeaders(self.id) }))
    }),
    worktrees: Effect.fn("Remote.worktrees")((machine: string, project: string | undefined) =>
      Effect.gen(function* () {
        const link = yield* machines.link(machine)

        if (link.capabilities.worktrees !== true)
          return yield* new MachineIncompatible({
            machine,
            message: `${machine} runs a vibest that does not list worktrees; run vibest update there`,
          })

        return yield* link.call(
          link.client["Worktree.List"](project === undefined ? {} : { project }, { headers: remoteHeaders(self.id) }),
        )
      }),
    ),

    list: Effect.fn("Remote.list")(function* (scope: ListScope, by: string, stopped: boolean | undefined) {
      if (Predicate.isTagged(scope, "Remote")) return { sessions: [], machines: [] }

      const each = yield* Effect.forEach(
        yield* machines.states,
        ({ info, link }): Effect.Effect<Away> =>
          link === undefined || !Predicate.isTagged(scope, "Project")
            ? Effect.succeed({ machine: info, sessions: [] })
            : link
                .call(
                  link.client.List(stopped === undefined ? {} : { stopped }, {
                    headers: remoteHeaders(self.id, scope.id, by),
                  }),
                )
                .pipe(
                  Effect.matchEffect({
                    onSuccess: (rows) =>
                      Effect.map(view(info.name, rows.sessions), (sessions) => ({ machine: info, sessions })),
                    onFailure: (e) =>
                      Effect.succeed({
                        machine: { ...info, state: "unreachable" as const, reason: e.message },
                        sessions: [],
                      }),
                  }),
                ),
        { concurrency: "unbounded" },
      )

      return { sessions: each.flatMap((e) => e.sessions), machines: each.map((e) => e.machine) }
    }),

    get: Effect.fn("Remote.get")((at: At, project: string, by: string, p: PayloadOf<"Get">) =>
      relay(at, project, by, (c, { id }, o) => c.Get({ ...p, id }, o)).pipe(
        Effect.flatMap((row) => Effect.map(view(at.machine, [row]), (rows) => rows[0]!)),
      ),
    ),

    peek: Effect.fn("Remote.peek")(function* (at: At, project: string, by: string, p: PayloadOf<"Peek">) {
      const { text } = yield* relay(at, project, by, (c, { id }, o) => c.Peek({ ...p, id }, o))

      const row = yield* relay(at, project, by, (c, { id }, o) => c.Get({ id }, o)).pipe(
        Effect.flatMap((row) => view(at.machine, [row])),
        Effect.map((rows) => rows[0]),
        Effect.orElseSucceed(() => undefined),
      )

      return {
        text,
        ...(row !== undefined && row.address.id !== "" && { terminal: row.address.id }),
        ...(row?.view !== undefined && { view: row.view }),
      }
    }),

    spawn: Effect.fn("Remote.spawn")(function* (
      machine: string,
      input: PayloadOf<"Spawn">,
      from: { readonly project: string; readonly session: string },
    ) {
      const refused = REFUSED.flatMap(([key, flag]) => (input[key] !== undefined ? [flag] : []))

      if (refused.length > 0)
        return yield* new MachineFailed({ message: `${refused.join(", ")} is not sent to another machine` })

      if (input.files !== undefined && input.files.length > 0) {
        const link = yield* machines.link(machine)

        if (link.capabilities.remoteSpawnFiles !== true)
          return yield* new MachineFailed({
            message: `${machine} runs a vibest that does not take --file; run vibest update there`,
          })
      }

      const repositories = yield* db.project.projectRemote(from.project)
      const directory = yield* db.project.projectDirectory(from.project)

      const folders =
        directory !== undefined
          ? yield* listProjectRepositories(directory).pipe(
              provided,
              Effect.mapError((e) => new MachineFailed({ message: `cannot read ${directory}: ${e.message}` })),
            )
          : undefined

      const pin = Effect.fn("Remote.pin")(function* (path: string, remote: string | undefined) {
        if (remote === undefined)
          return yield* new MachineFailed({
            message: `${path} has no remote with a network URL; another machine finds its checkout by the remote URL`,
          })

        const commit = yield* git
          .head(path)
          .pipe(Effect.mapError((e) => new MachineFailed({ message: `cannot read HEAD of ${path}: ${e.message}` })))

        const identity = yield* repositoryIdentity(remote)

        return { repository: remote, ...(identity !== undefined && { identity }), commit }
      })

      const only = repositories[0]
      const child = folders?.length === 1 ? folders[0] : undefined

      const sent =
        folders !== undefined && folders.length > 1
          ? {
              repositories: yield* Effect.forEach(folders, (folder) =>
                git.remoteUrl(folder.path).pipe(
                  Effect.flatMap((remote) => pin(folder.path, remote)),
                  Effect.map((entry) => ({ folder: folder.name, ...entry })),
                ),
              ),
            }
          : child !== undefined
            ? yield* pin(child.path, yield* git.remoteUrl(child.path))
            : folders === undefined && repositories.length === 1 && only !== undefined
              ? yield* pin(only.path, yield* git.remoteUrl(only.path))
              : yield* new MachineFailed({ message: "the project has no repository another machine can run in" })

      const capabilities = (yield* machines.link(machine)).capabilities

      if (input.project !== undefined && capabilities.remoteSpawnProject !== true)
        return yield* new MachineFailed({
          message: `${machine} runs a vibest that does not take --project; run vibest update on ${machine}`,
        })

      if ("repositories" in sent && capabilities.remoteSpawnRepositories !== true)
        return yield* new MachineFailed({
          message: `${machine} runs a vibest that does not take a project of several repositories; run vibest update on ${machine}`,
        })

      const runtime = input.runtime ?? callerKind(yield* runtimes.callers, input.callerEnv)
      const viewer = runtime === undefined ? undefined : (yield* runtimes.all).find((r) => r.id === runtime)

      const ready =
        viewer?.locate === undefined || runtime === undefined
          ? undefined
          : yield* machines.ensure(machine, runtime, new Map(), true)

      const spawned = yield* call(machine, from.project, from.session, (client, headers) =>
        client["Remote.Spawn"](
          {
            ...sent,
            ...(input.project !== undefined && { project: input.project }),
            agent: input.agent,
            prompt: input.prompt,
            ...(input.harness !== undefined && { harness: input.harness }),
            ...(input.provider !== undefined && { provider: input.provider }),
            ...(input.model !== undefined && { model: input.model }),
            ...(input.name !== undefined && { title: input.name }),
            ...(runtime !== undefined && { runtime }),
            request: input.request ?? randomId(),
            ...(input.files !== undefined && { files: input.files }),
          },
          { headers },
        ),
      )

      const machineRow = yield* db.remote.machineNamed(machine)

      if (machineRow !== undefined)
        yield* db.session.linkSessions([{ from: from.session, to: spawned.session, remote: machineRow.remoteId }])

      return {
        id: addressed(machine, spawned.session),
        harness: spawned.harness,
        ...(spawned.provider !== undefined && { provider: spawned.provider }),
        ...(spawned.model !== undefined && { model: spawned.model }),
        decidedBy: spawned.decidedBy,
        trace: spawned.trace,
        ...(ready?.note !== undefined && { notes: [{ message: ready.note }] }),
      }
    }),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Remote") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Db.node,
    Git.node,
    Machines.node,
    Runtimes.node,
    Identity.node,
    PlatformNode.fileSystem,
    PlatformNode.path,
    PlatformNode.layout,
    pluginLoaderNode,
  ],
})
