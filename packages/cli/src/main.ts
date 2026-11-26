#!/usr/bin/env bun
import * as Logging from "@vibest/client/logging"
import { commands } from "@vibest/plugin-builtins"
import { EmbeddedHarnesses, Layout, VibestCommand } from "@vibest/schema/layout"
import { Effect } from "effect"

import * as Platform from "#platform"

import { TypedAhead } from "./ask.ts"
import { userOnly } from "./caller.ts"
import * as Cli from "./cli.ts"
import { clients } from "./client.ts"
import { Commands } from "./commands/commands.ts"
import { materializeEmbedded } from "./embedded-assets.ts"
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
  stop: () => import("./commands/handlers/stop.ts"),
  peek: () => import("./commands/handlers/peek.ts"),
  archive: () => import("./commands/handlers/archive.ts"),
  ls: () => import("./commands/handlers/ls.ts"),
  session: {
    link: () => import("./commands/handlers/session/link.ts"),
    unlink: () => import("./commands/handlers/session/unlink.ts"),
  },
  events: () => import("./commands/handlers/events.ts"),
  models: () => import("./commands/handlers/models.ts"),
  harness: {
    list: () => import("./commands/handlers/harness/list.ts"),
    models: () => import("./commands/handlers/harness/models.ts"),
  },
  agent: {
    list: () => import("./commands/handlers/agent/list.ts"),
    show: () => import("./commands/handlers/agent/show.ts"),
  },
  project: {
    create: () => import("./commands/handlers/project/create.ts"),
    clone: () => import("./commands/handlers/project/clone.ts"),
    add: () => import("./commands/handlers/project/add.ts"),
    move: () => import("./commands/handlers/project/move.ts"),
    info: () => import("./commands/handlers/project/info.ts"),
    search: () => import("./commands/handlers/project/search.ts"),
  },
  worktree: {
    list: () => import("./commands/handlers/worktree/list.ts"),
  },
  plugins: () => import("./commands/handlers/plugins.ts"),
  mcp: {
    list: () => import("./commands/handlers/mcp/list.ts"),
    add: () => import("./commands/handlers/mcp/add.ts"),
    remove: () => import("./commands/handlers/mcp/remove.ts"),
    search: () => import("./commands/handlers/mcp/search.ts"),
    read: () => import("./commands/handlers/mcp/read.ts"),
    call: () => import("./commands/handlers/mcp/call.ts"),
    exec: () => import("./commands/handlers/mcp/exec.ts"),
    auth: {
      start: () => import("./commands/handlers/mcp/auth/start.ts"),
      complete: () => import("./commands/handlers/mcp/auth/complete.ts"),
      "set-token": () => import("./commands/handlers/mcp/auth/set-token.ts"),
      logout: () => import("./commands/handlers/mcp/auth/logout.ts"),
    },
  },
  auto: {
    create: () => import("./commands/handlers/auto/create.ts"),
    list: () => import("./commands/handlers/auto/list.ts"),
    get: () => import("./commands/handlers/auto/get.ts"),
    pause: () => import("./commands/handlers/auto/pause.ts"),
    resume: () => import("./commands/handlers/auto/resume.ts"),
    remove: () => import("./commands/handlers/auto/remove.ts"),
    "run-now": () => import("./commands/handlers/auto/run-now.ts"),
  },
  subscriptions: () => import("./commands/handlers/subscriptions.ts"),
  onboard: () => import("./commands/handlers/onboard.ts"),
  doctor: () => import("./commands/handlers/doctor.ts"),
  update: () => import("./commands/handlers/update.ts"),
  connect: () => import("./commands/handlers/connect.ts"),
  machine: {
    add: () => import("./commands/handlers/machine/add.ts"),
    list: () => import("./commands/handlers/machine/ls.ts"),
    remove: () => import("./commands/handlers/machine/rm.ts"),
  },
})

const embeddedHarnesses = (home: string) => materializeEmbedded(home)?.harnesses

const replacements = [...Platform.replacements, Platform.app({ version: VERSION }), Platform.updateCheck(updater)]

Runtime.run(Commands, Handlers, {
  version: VERSION,
  extra: { after: "update", commands: commands(userOnly, clients) },
}).pipe(
  Cli.printFailure,
  Effect.provideService(EmbeddedHarnesses, embeddedHarnesses),
  Effect.provide(Layout.layer),
  Effect.provide(Logging.layer),
  Effect.provideService(VibestCommand, Platform.selfCommand),
  Effect.provideService(Host, {
    daemon: Platform.daemon,
    replacements,
    exec: Platform.exec,
    parseJsonc: Platform.parseJsonc,
  }),
  Effect.provide(TypedAhead.layer),
  Effect.provide(Platform.services),
  (program) => Platform.runMain(program, { disableErrorReporting: true, teardown: Cli.teardown }),
)
