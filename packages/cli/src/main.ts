#!/usr/bin/env bun
import { commands } from "@vibest/builtins"
import * as Logging from "@vibest/client/logging"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import { Effect } from "effect"

import * as Platform from "#platform"

import { userOnly } from "./caller.ts"
import * as Cli from "./cli.ts"
import { clients } from "./client.ts"
import { Commands } from "./commands/commands.ts"
import { Runtime } from "./framework/runtime.ts"
import { Host } from "./host.ts"
import { updater } from "./update-check.ts"
import { VERSION } from "./version.ts"

const Handlers = Runtime.handlers(Commands, {
  $: () => import("./commands/handlers/default.ts"),
  daemon: {
    $: () => import("./commands/handlers/daemon/default.ts"),
    restart: () => import("./commands/handlers/daemon/restart.ts"),
    "import-check": () => import("./commands/handlers/daemon/import-check.ts"),
  },
  run: () => import("./commands/handlers/run.ts"),
  send: () => import("./commands/handlers/send.ts"),
  status: () => import("./commands/handlers/status.ts"),
  result: () => import("./commands/handlers/result.ts"),
  interrupt: () => import("./commands/handlers/interrupt.ts"),
  peek: () => import("./commands/handlers/peek.ts"),
  archive: () => import("./commands/handlers/archive.ts"),
  ls: () => import("./commands/handlers/ls.ts"),
  events: () => import("./commands/handlers/events.ts"),
  models: () => import("./commands/handlers/models.ts"),
  harness: {
    list: () => import("./commands/handlers/harness/list.ts"),
    models: () => import("./commands/handlers/harness/models.ts"),
  },
  project: {
    create: () => import("./commands/handlers/project/create.ts"),
    add: () => import("./commands/handlers/project/add.ts"),
    info: () => import("./commands/handlers/project/info.ts"),
    search: () => import("./commands/handlers/project/search.ts"),
  },
  plugins: () => import("./commands/handlers/plugins.ts"),
  subscriptions: () => import("./commands/handlers/subscriptions.ts"),
  integration: {
    guard: () => import("./commands/handlers/integration/guard.ts"),
    prompt: () => import("./commands/handlers/integration/prompt.ts"),
    stop: () => import("./commands/handlers/integration/stop.ts"),
    ready: () => import("./commands/handlers/integration/ready.ts"),
  },
  doctor: () => import("./commands/handlers/doctor.ts"),
  update: () => import("./commands/handlers/update.ts"),
  connect: () => import("./commands/handlers/connect.ts"),
  machine: {
    add: () => import("./commands/handlers/machine/add.ts"),
    ls: () => import("./commands/handlers/machine/ls.ts"),
    rm: () => import("./commands/handlers/machine/rm.ts"),
  },
})

const replacements = [...Platform.replacements, Platform.app({ version: VERSION }), Platform.updateCheck(updater)]

Runtime.run(Commands, Handlers, {
  version: VERSION,
  extra: { after: "update", commands: commands(userOnly, clients) },
}).pipe(
  Cli.printFailure,
  Effect.provide(Layout.layer),
  Effect.provide(Logging.layer),
  Effect.provideService(VibestCommand, Platform.selfCommand),
  Effect.provideService(Host, { daemon: Platform.daemon, replacements, exec: Platform.exec }),
  Effect.provide(Platform.services),
  (program) => Platform.runMain(program, { disableErrorReporting: true, teardown: Cli.teardown }),
)
