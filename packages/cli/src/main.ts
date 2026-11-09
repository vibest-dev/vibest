#!/usr/bin/env bun
import { Layout, VibestCommand } from "@vibest/core/paths"
import { VERSION } from "@vibest/protocol/rpc"
import { Effect } from "effect"
import { Command } from "effect/cli"

import * as Platform from "#platform"

import * as Cli from "./cli.ts"

Cli.command(Platform.daemon, Platform.exec).pipe(
  Command.run({ version: VERSION }),
  Cli.printFailure,
  Effect.provide(Layout.layer),
  Effect.provideService(VibestCommand, Platform.selfCommand),
  Effect.provide(Platform.services),
  (program) => Platform.runMain(program, { disableErrorReporting: true, teardown: Cli.teardown }),
)
