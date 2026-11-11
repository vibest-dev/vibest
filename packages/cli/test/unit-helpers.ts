import { Bus } from "@vibest/core/bus"
import { Db, type NewSession } from "@vibest/core/db"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Layer } from "effect"

import * as Platform from "#platform"

export const database = (filename: string) =>
  Db.layer.pipe(Layer.provide(Platform.sqlite(filename)), Layer.provide(Bus.layer))

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
  address: { machine: "local", id: "default" },
  status: "unknown",
  startedAt: null,
  exitedAt: null,
  executionState: "none",
  executionPromptedAt: 0,
  metadata: {},
  createdAt: 1,
  lastActive: 1,
  ...patch,
})
export const place = { runtime: RUNTIME, address: { machine: "local", id: "test/p1" } }
