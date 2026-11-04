#!/usr/bin/env bun
import { VERSION } from "@vibest/protocol/rpc"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import { LocalHarnesses } from "@vibest/server/entry"
import { Effect } from "effect"
import { Command } from "effect/cli"

// Entry point of `vibest` / vibestd: the one place (besides the host, @vibest/server/platform) that picks the product, through `#platform`.
// The terminal runtime comes from the builtin runtime plugin (runtime-port.md §2), not a layer here.
import * as Platform from "#platform"

import * as Cli from "./cli.ts"

Cli.command(Platform.daemon, Platform.exec).pipe(
  Command.run({ version: VERSION }),
  Cli.printFailure,
  Effect.provide(Layout.layer),
  Effect.provide(LocalHarnesses.builtins),
  Effect.provideService(VibestCommand, Platform.selfCommand),
  Effect.provide(Platform.services),
  (program) => Platform.runMain(program, { disableErrorReporting: true, teardown: Cli.teardown }),
)
