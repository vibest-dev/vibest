import type { Plugin } from "@vibest/plugin"

export interface Builtin {
  readonly source: string
  readonly revision: string
  readonly options: Readonly<Record<string, unknown>>
  readonly plugin: Plugin.Plugin
}

export const pre: ReadonlyArray<Builtin> = []
