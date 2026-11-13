#!/usr/bin/env bun
import { Layout, VibestCommand } from "@vibest/schema/layout"
import { Effect } from "effect"
import { Command } from "effect/cli"

import * as Platform from "#platform"

import * as Cli from "./cli.ts"
import { Host } from "./host.ts"
import { updater } from "./update-check.ts"
import { VERSION } from "./version.ts"

const replacements = [...Platform.replacements, Platform.app({ version: VERSION }), Platform.updateCheck(updater)]

Cli.command.pipe(
  Command.run({ version: VERSION }),
  Cli.printFailure,
  Effect.provide(Layout.layer),
  Effect.provideService(VibestCommand, Platform.selfCommand),
  Effect.provideService(Host, { daemon: Platform.daemon, replacements, exec: Platform.exec }),
  Effect.provide(Platform.services),
  (program) => Platform.runMain(program, { disableErrorReporting: true, teardown: Cli.teardown }),
)
