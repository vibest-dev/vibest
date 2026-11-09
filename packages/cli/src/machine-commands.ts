import { probe, startDaemon, type VibestClient, withVibest } from "@vibest/client/client"
import { Layout } from "@vibest/core/paths"
import { shortId } from "@vibest/schema/id"
import { Console, Effect, Path, Schema } from "effect"
import { Argument, Command } from "effect/cli"

import { caller, userOnly } from "./caller.ts"
import { pipeStdio } from "./connect.ts"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const json = (value: unknown) => Console.log(encodeJson(value))

const vibest = <A, E, R>(f: (client: VibestClient) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(caller, (c) => withVibest(c.claim, f, { start: !c.agent }))

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
            ),
          ),
        ),
    ).pipe(Command.withDescription("Connect once to a machine's vibestd over ssh and keep it as a machine")),
    Command.make("ls", {}, () =>
      userOnly("machine ls").pipe(Effect.andThen(vibest((client) => client["Machine.List"]())), Effect.flatMap(json)),
    ).pipe(Command.withDescription("The machines this vibestd dials, with their connection state (JSON)")),
    Command.make("rm", { name: Argument.String("name") }, (o) =>
      userOnly("machine rm").pipe(
        Effect.andThen(vibest((client) => client["Machine.Remove"]({ name: o.name }))),
        Effect.andThen(json({ removed: o.name })),
      ),
    ).pipe(
      Command.withDescription(
        "Forget a machine: its connection stops; its agents keep running there and adding it again delivers their results",
      ),
    ),
  ]),
)

export const peer = Command.make("peer").pipe(
  Command.withDescription("Other machines' vibestds that dial this one (vibest machine add there)"),
  Command.withSubcommands([
    Command.make("ls", {}, () =>
      userOnly("peer ls").pipe(Effect.andThen(vibest((client) => client["Peers.List"]())), Effect.flatMap(json)),
    ).pipe(
      Command.withDescription(
        "The vibestds that dial this one: name, the name they call this machine, connected or last connected, undelivered results and open sessions (JSON)",
      ),
    ),
    Command.make(
      "rm",
      {
        peer: Argument.String("peer").pipe(
          Argument.withDescription("Its id, a unique id prefix of 8 or more, or its name"),
        ),
      },
      (o) =>
        userOnly("peer rm").pipe(
          Effect.andThen(vibest((client) => client["Peers.Remove"]({ peer: o.peer }))),
          Effect.flatMap(json),
        ),
    ).pipe(
      Command.withDescription(
        "Forget a peer and drop its undelivered results; its sessions keep running here and their later results are not queued",
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
