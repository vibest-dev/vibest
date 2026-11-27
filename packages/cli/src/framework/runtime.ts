import { type HttpConnector } from "@vibest/client/client"
import { type SocketConnector } from "@vibest/client/socket-connector"
import { type Layout } from "@vibest/schema/layout"
import { Effect, Predicate, Stdio } from "effect"
import { Command } from "effect/cli"
import { type HttpClient } from "effect/http"

import { type Host } from "../host.ts"
import { withErasedInput } from "./runtime-erased.ts"
import type { Spec } from "./spec.ts"

export type Environment =
  | Command.Environment
  | Host
  | Layout
  | SocketConnector.Service
  | HttpConnector.Service
  | HttpClient.HttpClient

export type Input<Value> =
  Value extends Spec.Node<infer _Name, infer Command, infer _Commands>
    ? Input<Command>
    : Value extends Command.Command<infer _Name, infer Input, infer _Context, infer _Error, infer _Requirements>
      ? Input
      : never

type RuntimeHandler = <Input>(input: Input) => Effect.Effect<void, unknown, Environment>

type Loader<Node extends Spec.Any> = () => Promise<{
  default: (input: Input<Node>) => Effect.Effect<void, any, Environment>
}>

export type ProvidedCommand = Command.Command<string, unknown, unknown, unknown, Environment>

export type Handlers<Node extends Spec.Any> = keyof Node["commands"] extends never
  ? Loader<Node>
  : { readonly $?: Loader<Node> } & { readonly [Key in keyof Node["commands"]]: Handlers<Node["commands"][Key]> }

type RuntimeLoader = () => Promise<{ default: RuntimeHandler }>

type RuntimeHandlers =
  | RuntimeLoader
  | { readonly $?: RuntimeLoader; readonly [key: string]: RuntimeHandlers | undefined }

interface LazyHandler {
  readonly spec: Command.Command.Any
  readonly load: RuntimeLoader
}

export interface Extra {
  readonly after: string
  readonly commands: ReadonlyArray<Command.Command<any, any, any, any, Environment>>
}

export function handler<const Node extends Spec.Any, Error>(
  _node: Node,
  run: (input: Input<Node>) => Effect.Effect<void, Error, Environment>,
) {
  return run
}

export function handlers<const Root extends Spec.Any>(root: Root, handlers: Handlers<Root>): Array<LazyHandler>
export function handlers(root: Spec.Any, handlers: RuntimeHandlers): Array<LazyHandler> {
  const result: Array<LazyHandler> = []

  function add(node: Spec.Any, value: RuntimeHandlers | undefined) {
    if (value === undefined) throw new Error(`no handler registered for command ${node.name}`)

    if (Predicate.isFunction(value)) {
      result.push({ spec: node.spec, load: value })

      return
    }

    if (value.$) result.push({ spec: node.spec, load: value.$ })

    for (const [name, child] of Object.entries(node.commands)) add(child, value[name])
  }

  add(root, handlers)

  return result
}

export function run(
  commands: Spec.Any,
  handlers: ReadonlyArray<LazyHandler>,
  options: {
    readonly version: string
    readonly extra: Extra
    readonly args?: (args: ReadonlyArray<string>) => ReadonlyArray<string>
  },
) {
  const command = Command.runWith(provide(commands, handlers, options.extra), { version: options.version })

  return Stdio.Stdio.use(({ args }) => Effect.flatMap(args, (args) => command(options.args?.(args) ?? args)))
}

function provide(node: Spec.Any, handlers: ReadonlyArray<LazyHandler>, extra?: Extra): ProvidedCommand {
  const handler = handlers.find((handler) => handler.spec === node.spec)

  const spec = handler
    ? node.spec.pipe(
        Command.withHandler((input) => Effect.flatMap(Effect.promise(handler.load), (module) => module.default(input))),
      )
    : node.spec

  const children = Object.entries(node.commands).map(([name, child]) => [name, provide(child, handlers)] as const)

  if (children.length === 0) return spec
  const at = extra === undefined ? children.length : children.findIndex(([name]) => name === extra.after) + 1

  return withErasedInput(
    spec.pipe(
      Command.withSubcommands([
        ...children.slice(0, at).map(([, child]) => child),
        ...(extra?.commands ?? []),
        ...children.slice(at).map(([, child]) => child),
      ]),
    ),
  )
}

export * as Runtime from "./runtime.ts"
