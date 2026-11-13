#!/usr/bin/env bun
import { App } from "@vibest/schema/app"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import { Effect } from "effect"
import { Command } from "effect/cli"

import * as Platform from "#platform"

import * as Cli from "./cli.ts"
import { VERSION } from "./version.ts"

const replacements = [...Platform.replacements, Platform.app(VERSION)]

Cli.command(Platform.daemon, replacements, Platform.exec).pipe(
  Command.run({ version: VERSION }),
  Cli.printFailure,
  Effect.provideService(App, { version: VERSION }),
  Effect.provide(Layout.layer),
  Effect.provideService(VibestCommand, Platform.selfCommand),
  Effect.provide(Platform.services),
  (program) => Platform.runMain(program, { disableErrorReporting: true, teardown: Cli.teardown }),
)
