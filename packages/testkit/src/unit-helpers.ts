import { Bus } from "@vibest/core/bus"
import { Database } from "@vibest/core/database/database"
import type { NewSession } from "@vibest/core/database/rows"
import { InboxStore } from "@vibest/core/inbox/store"
import { ProjectStore } from "@vibest/core/project/store"
import { Projectors } from "@vibest/core/reactor"
import { RemoteStore } from "@vibest/core/remote/store"
import { SessionLive } from "@vibest/core/session/live"
import { SessionStore } from "@vibest/core/session/store"
import * as Platform from "@vibest/platform-bun/bun"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Layer } from "effect"

export const memoryBus = Bus.layer.pipe(Layer.provide(Platform.sqlite(":memory:")))

export const database = (filename: string) =>
  Layer.mergeAll(ProjectStore.layer, SessionStore.layer, InboxStore.layer, RemoteStore.layer).pipe(
    Layer.provideMerge(Database.layer),
    Layer.provide(Projectors.layer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionLive.layer),
    Layer.provide(Platform.sqlite(filename)),
  )

export const session = (
  id: string,
  patch: Partial<Omit<NewSession, "projectId">> = {},
): Omit<NewSession, "projectId"> => ({
  id,
  agent: "general",
  name: "n",
  harnessId: "pi",
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: RUNTIME,
  terminal: { id: "default" },
  status: "unknown",
  startedAt: null,
  exitedAt: null,
  executionState: "none",
  executionPromptedAt: 0,
  createdAt: 1,
  lastActive: 1,
  ...patch,
})

export const place = { runtime: RUNTIME, target: { id: "test/p1" } }
