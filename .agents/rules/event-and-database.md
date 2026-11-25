# Event and Database

1. **Event definitions live in `@vibest/schema`**, split one file per domain (`project-event.ts`, `session-event.ts`, `process-event.ts`, `machine-event.ts`), built with `Event.durable("<domain>.<event>", version, schema)`, `Event.ephemeral(...)`, `Event.inventory(...)`, and `Event.durableMap(...)` (`packages/schema/src/event.ts`). `durable-event-manifest.ts` owns exhaustive projector coverage across every durable event, and `PublicEvents` defines the public event stream boundary visible to plugins and `vibest events`.
2. **Explicit entity IDs**: `projectId`, `sessionId`, `processId`, `messageId`, and `requestId` are generated up front as explicit identifiers, never coupled to SQLite `event.seq` autoincrement numbers.
3. **Atomic ledger + projection commits**: all durable mutations execute inside `bus.transaction` under `packages/core/src/database/`. Each transaction writes projection rows and records durable events with `bus.publish(...)` in one atomic SQLite transaction; in-memory `Bus` subscribers receive committed events only after the transaction commits. SQL lives only under `packages/core/src/database/`.
4. **SQLite schema and concurrency invariants**:
   - Rely on `@effect/sql-sqlite-bun`'s native `PRAGMA busy_timeout = 5000` and `sql.withTransaction` (`BEGIN IMMEDIATE` + semaphore + `SAVEPOINT`).
   - Explicitly retry `PRAGMA journal_mode = WAL` and pre-open `inspectSchema` on `LockTimeoutError` / `ConnectionError` (SQLite's `PRAGMA journal_mode = WAL` bypasses `busy_timeout`).
   - Enforce `PRAGMA foreign_keys = ON`.
   - Maintain monotonic `event_sequence` and store `versionedType` (`<type>.<version>`) in the `event` ledger.
   - Start up in O(1) without dropping or replaying projections on every boot; schema changes use strictly append-only incremental migrations (`packages/core/src/database/migration.ts`, recorded in the `migration` table).

Status: in force (`packages/schema/src/*-event.ts`, `packages/core/src/database/`).
