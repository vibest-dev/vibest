import { Command } from "effect/cli"

import { childrenOf, noParams } from "./spec-erased.ts"

type Options<Config extends Command.Command.Config, Commands extends ReadonlyArray<Any>> = {
  readonly description?: string
  readonly alias?: string
  readonly params?: Config
  readonly commands?: Commands
}

export interface Node<
  Name extends string,
  Spec extends Command.Command<Name, any, any, any, any>,
  Commands extends Children,
> {
  readonly name: Name
  readonly spec: Spec
  readonly commands: Commands
}

export type Any = Node<string, Command.Command<any, any, any, any, any>, Children>

export type Children = Readonly<Record<string, Any>>

export type ChildrenOf<Commands extends ReadonlyArray<Any>> = {
  readonly [Node in Commands[number] as Node["name"]]: Node
}

export function make<
  const Name extends string,
  const Config extends Command.Command.Config = {},
  const Commands extends ReadonlyArray<Any> = [],
>(name: Name, options: Options<Config, Commands> = {}) {
  const command = Command.make(name, options.params ?? noParams<Config>())
  const described = options.description ? command.pipe(Command.withDescription(options.description)) : command
  const spec = options.alias ? described.pipe(Command.withAlias(options.alias)) : described

  const children = Object.fromEntries((options.commands ?? []).map((command) => [command.name, command]))

  return { name, spec, commands: childrenOf<Commands>(children) }
}

export * as Spec from "./spec.ts"
