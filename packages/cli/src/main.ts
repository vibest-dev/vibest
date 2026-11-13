#!/usr/bin/env bun
import * as Logging from "@vibest/client/logging"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import { Effect } from "effect"
import { Command } from "effect/cli"

import * as Platform from "#platform"

import * as Cli from "./cli.ts"
import { updater } from "./update-check.ts"
import { VERSION } from "./version.ts"

const replacements = [...Platform.replacements, Platform.app({ version: VERSION }), Platform.updateCheck(updater)]

Cli.command(Platform.daemon, replacements, Platform.exec).pipe(
  Command.run({ version: VERSION }),
  Cli.printFailure,
  Effect.provide(Layout.layer),
  Effect.provide(Logging.layer),
  Effect.provideService(VibestCommand, Platform.selfCommand),
  Effect.provide(Platform.services),
  (program) => Platform.runMain(program, { disableErrorReporting: true, teardown: Cli.teardown }),
)
