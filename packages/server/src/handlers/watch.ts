import { VibestApi } from "@vibest/protocol/api"
import { Caller } from "@vibest/protocol/middleware"
import type { WatchEvent } from "@vibest/protocol/schemas"
import { Effect, Predicate, Stream } from "effect"
import { HttpApiBuilder } from "effect/http-api"

import * as Listing from "../listing.ts"
import { RemoteWatch } from "../machine/remote-watch.ts"
import { ListScope } from "../machine/remote.ts"
import { WatchFeed } from "../watch-feed.ts"
import * as CallerChecks from "./caller.ts"

export const WatchHandler = HttpApiBuilder.group(VibestApi, "server.watch", (handlers) =>
  Effect.gen(function* () {
    const { userOnly } = yield* CallerChecks.Service
    const { listed, watched, snapshotProjects } = yield* Listing.Service
    const watchFeed = yield* WatchFeed.Service
    const remoteWatch = yield* RemoteWatch.Service

    return handlers.handle("watch.subscribe", () =>
      Effect.gen(function* () {
        const caller = yield* Caller

        if (!Predicate.isTagged(caller, "Remote")) yield* userOnly("watch.subscribe")

        return Stream.unwrap(
          Effect.gen(function* () {
            const localChanges = yield* watchFeed.subscribe
            const sessionRows = yield* watched(yield* listed(ListScope.All(), false, true))
            const localProjects = yield* snapshotProjects(sessionRows)

            if (Predicate.isTagged(caller, "Remote")) {
              const snapshot: WatchEvent = Listing.WatchEvents.Snapshot({
                projects: localProjects,
                sessions: sessionRows,
                machines: [],
              })

              return Stream.concat(Stream.make(snapshot), localChanges)
            }

            const remoteChanges = yield* remoteWatch.subscribe
            const remote = yield* remoteWatch.snapshot

            const snapshot: WatchEvent = Listing.WatchEvents.Snapshot({
              projects: [...localProjects, ...remote.projects],
              sessions: [...sessionRows, ...remote.sessions],
              machines: remote.machines,
            })

            return Stream.concat(Stream.make(snapshot), Stream.merge(localChanges, remoteChanges))
          }),
        )
      }),
    )
  }),
)
