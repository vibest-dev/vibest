#!/usr/bin/env bun
import * as BuiltinHarnesses from "@vibest/core/harnesses"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { VERSION } from "@vibest/protocol/rpc"
import { Effect } from "effect"
import { Command } from "effect/cli"

// Entry point of `vibest` / vibestd: the one place (besides src/platform) that picks the product, through `#platform`.
// The terminal runtime comes from the builtin runtime plugin (runtime-port.md §2), not a layer here.
import * as Platform from "#platform"

import * as Cli from "./cli.ts"

Cli.command(Platform.daemon, Platform.exec).pipe(
  Command.run({ version: VERSION }),
  Cli.printFailure,
  Effect.provide(Layout.layer),
  Effect.provide(BuiltinHarnesses.layer),
  Effect.provideService(VibestCommand, Platform.selfCommand),
  Effect.provide(Platform.services),
  (program) => Platform.runMain(program, { disableErrorReporting: true, teardown: Cli.teardown }),
)
