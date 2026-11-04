// vibest's SQLite store passes the engine's storage contract (@vibest/core/storage-conformance), as the in-memory store does.
import { storageConformance } from "@vibest/core/storage-conformance"
import * as SqliteStorage from "@vibest/vibest/sqlite-storage"
import { Layer } from "effect"

import * as Platform from "#platform"

storageConformance("SQLite", SqliteStorage.layer.pipe(Layer.provide(Platform.sqlite(":memory:"))))
