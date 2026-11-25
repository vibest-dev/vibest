import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import type { NewSession } from "@vibest/core/database/db-rows"
import * as Projectors from "@vibest/core/database/projectors"
import { SessionLive } from "@vibest/core/session/live"
import * as Platform from "@vibest/platform-bun/bun"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Layer } from "effect"

export const memoryBus = Bus.layer.pipe(Layer.provide(Platform.sqlite(":memory:")))

export const database = (filename: string) =>
  Db.layer.pipe(
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
