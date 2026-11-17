import type { Command } from "effect/cli"

import type { Any, Children, ChildrenOf } from "./spec.ts"

export const noParams = <Config extends Command.Command.Config>() => ({}) as Config

export const childrenOf = <Commands extends ReadonlyArray<Any>>(children: Children) => children as ChildrenOf<Commands>
