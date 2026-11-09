import { probe, startDaemon, type VibestClient, withVibest } from "@vibest/client/client"
import { Layout } from "@vibest/core/paths"
import { shortId } from "@vibest/schema/id"
import type { MachineNote } from "@vibest/schema/machine"
import { Console, Effect, Path } from "effect"
import { Argument, Command } from "effect/cli"

import { json, userOnly, vibest } from "./caller.ts"
import { pipeStdio } from "./connect.ts"

export const connectCommand = Command.make("connect", {}, () =>
  userOnly("connect").pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const layout = yield* Layout
        if (!(yield* probe(layout.socket))) yield* startDaemon
        yield* pipeStdio(layout.socket)
      }),
    ),
  ),
).pipe(
  Command.withDescription(
    "Internal: what another machine's vibestd runs over ssh. Joins stdin and stdout to this machine's vibestd, starting it when it is not running",
  ),
)

const printNotes = (notes: ReadonlyArray<MachineNote>) =>
  Effect.forEach(
    notes,
    (note) =>
      Console.log(
        `note${note.plugin === undefined ? "" : ` (${note.plugin})`}: ${note.message}${note.fix === undefined ? "" : `; fix: ${note.fix}`}`,
      ),
    { discard: true },
  )

export const machine = Command.make("machine").pipe(
  Command.withDescription("Other machines this vibestd dials over ssh, to run agents there (vibest run --machine)"),
  Command.withSubcommands([
    Command.make(
      "add",
      {
        name: Argument.String("name").pipe(Argument.withDescription("What --machine and addresses name/<id> use")),
        target: Argument.String("target").pipe(
          Argument.withDescription("ssh target: user@host, user@host:port, or a Host of the ssh config"),
        ),
      },
      (o) =>
        userOnly("machine add").pipe(
          Effect.andThen(vibest((client) => client["Machine.Add"]({ name: o.name, target: o.target }))),
          Effect.flatMap((added) =>
            Console.log(
              `added ${added.name}: vibestd ${added.vibestd} (${shortId(added.id)}), vibest ${added.version}; connected`,
            ).pipe(Effect.andThen(printNotes(added.notes))),
          ),
        ),
    ).pipe(Command.withDescription("Connect once to a machine's vibestd over ssh and keep it as a machine")),
    Command.make("ls", {}, () =>
      userOnly("machine ls").pipe(Effect.andThen(vibest((client) => client["Machine.List"]())), Effect.flatMap(json)),
    ).pipe(
      Command.withDescription(
        "The machines this vibestd dials, with their connection state, their runtimes and whether this machine shows their terminals (JSON)",
      ),
    ),
    Command.make("rm", { name: Argument.String("name") }, (o) =>
      userOnly("machine rm").pipe(
        Effect.andThen(vibest((client) => client["Machine.Remove"]({ name: o.name }))),
        Effect.flatMap((removed) => json({ removed: o.name, notes: removed.notes })),
      ),
    ).pipe(
      Command.withDescription(
        "Forget a machine: its connection stops; its agents keep running there and adding it again delivers their results",
      ),
    ),
  ]),
)

export const projectAdd = <A, E, R>(openProject: (client: VibestClient) => Effect.Effect<A, E, R>) =>
  Command.make("add", { directory: Argument.String("directory").pipe(Argument.withDefault(".")) }, (o) =>
    Effect.gen(function* () {
      yield* userOnly("project add")
      const repositoryRoot = (yield* Path.Path).resolve(o.directory)
      const opened = yield* withVibest({ _tag: "cli", repositoryRoot }, openProject, { start: true })
      yield* json(opened)
    }),
  ).pipe(
    Command.withDescription(
      "Record a checkout as a project without starting a main agent, so another machine's vibestd can run agents in it",
    ),
  )
