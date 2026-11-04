// vibest's SQLite store passes the engine's storage contract (@vibest/core/store-contract), as the in-memory store does.
import { storeContract } from "@vibest/core/store-contract"
import * as SqliteStore from "@vibest/vibest/sqlite-store"
import { Layer } from "effect"

import * as Platform from "#platform"

storeContract("SQLite", SqliteStore.layer.pipe(Layer.provide(Platform.sqlite(":memory:"))))
