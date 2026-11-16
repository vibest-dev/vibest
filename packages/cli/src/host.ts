import type * as Daemon from "@vibest/server/daemon"
import { Context } from "effect"

export type Exec = (file: string, args: ReadonlyArray<string>, env: Record<string, string>) => void

export class Host extends Context.Service<
  Host,
  {
    readonly daemon: Daemon.Host
    readonly replacements: Daemon.Replacements
    readonly exec: Exec
  }
>()("@vibest/cli/Host") {}
