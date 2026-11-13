import { Effect } from "effect"
import { Command } from "effect/cli"

import type * as Spec from "./spec.ts"

export type Input<Value> =
  Value extends Spec.Node<infer _Name, infer Command, infer _Commands>
    ? Input<Command>
    : Value extends Command.Command<infer _Name, infer Input, infer _Context, infer _Error, infer _Requirements>
      ? Input
      : never

type Loader<Node extends Spec.Any> = () => Promise<{
  default: (input: Input<Node>) => Effect.Effect<void, any, any>
}>

export type Handlers<Node extends Spec.Any> = keyof Node["commands"] extends never
  ? Loader<Node>
  : { readonly $?: Loader<Node> } & { readonly [Key in keyof Node["commands"]]: Handlers<Node["commands"][Key]> }

type RuntimeLoader = () => Promise<{ default: (input: unknown) => Effect.Effect<void, unknown, unknown> }>

type RuntimeHandlers =
  | RuntimeLoader
  | { readonly $?: RuntimeLoader; readonly [key: string]: RuntimeHandlers | undefined }

interface LazyHandler {
  readonly spec: Command.Command.Any
  readonly load: RuntimeLoader
}

export function handler<const Node extends Spec.Any, Error, Requirements>(
  _node: Node,
  run: (input: Input<Node>) => Effect.Effect<void, Error, Requirements>,
) {
  return run
}

export function handlers<const Root extends Spec.Any>(root: Root, handlers: Handlers<Root>) {
  const result: Array<LazyHandler> = []

  function add(node: Spec.Any, value: RuntimeHandlers) {
    if (typeof value === "function") {
      result.push({ spec: node.spec, load: value })
      return
    }
    if (value.$) result.push({ spec: node.spec, load: value.$ })
    for (const [name, child] of Object.entries(node.commands)) add(child, value[name] as RuntimeHandlers)
  }

  add(root, handlers as unknown as RuntimeHandlers)
  return result
}

export function command<Requirements>(
  root: Spec.Any,
  handlers: ReadonlyArray<LazyHandler>,
  extra: ReadonlyArray<Command.Command.Any>,
) {
  return provide(root, handlers, extra) as Command.Command<string, unknown, unknown, unknown, Requirements>
}

function provide(
  node: Spec.Any,
  handlers: ReadonlyArray<LazyHandler>,
  extra: ReadonlyArray<Command.Command.Any> = [],
): Command.Command.Any {
  const handler = handlers.find((handler) => handler.spec === node.spec)
  const spec = handler
    ? node.spec.pipe(
        Command.withHandler((input) => Effect.flatMap(Effect.promise(handler.load), (module) => module.default(input))),
      )
    : node.spec
  const children = Object.values(node.commands)
  if (children.length === 0 && extra.length === 0) return spec
  return spec.pipe(
    Command.withSubcommands([...children.map((child) => provide(child, handlers)), ...extra]),
  ) as Command.Command.Any
}
