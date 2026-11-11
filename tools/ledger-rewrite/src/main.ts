import { dlopen, FFIType } from "bun:ffi"
import fs from "node:fs"
import path from "node:path"

import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

import { rewrite, RewriteFailed } from "./rewrite.ts"

const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})
const LOCK_EX_NB = 2 | 4

const holdStartLock = (home: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const file = path.join(home, "vibestd.pid")
      const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o600)
      if (libc.symbols.flock(fd, LOCK_EX_NB) === 0) return fd
      fs.closeSync(fd)
      return undefined
    }),
    (fd) => Effect.sync(() => fd !== undefined && fs.closeSync(fd)),
  ).pipe(
    Effect.flatMap((fd) =>
      fd === undefined
        ? new RewriteFailed({
            message: `vibestd is running (it holds ${path.join(home, "vibestd.pid")}); stop it first`,
          })
        : Effect.void,
    ),
  )

const scratch = Layer.build(SqliteClient.layer({ filename: ":memory:" })).pipe(
  Effect.flatMap((context) => SqlClient.SqlClient.pipe(Effect.provide(context))),
)

export const run = (file: string) =>
  Effect.gen(function* () {
    if (!fs.existsSync(file)) return yield* new RewriteFailed({ message: `${file} does not exist` })
    yield* holdStartLock(path.dirname(file))
    const report = yield* rewrite(yield* scratch).pipe(
      Effect.provide(SqliteClient.layer({ filename: file, disableWAL: true })),
    )
    return report
  }).pipe(Effect.scoped)

if (import.meta.main) {
  const file = process.argv[2]
  if (file === undefined) {
    process.stderr.write("usage: bun tools/ledger-rewrite/src/main.ts <vibest.db>\n")
    process.exit(2)
  }
  const outcome = await Effect.runPromise(
    run(path.resolve(file)).pipe(
      Effect.match({
        onFailure: (e) => ({ failed: e.message }),
        onSuccess: (report) => ({ report }),
      }),
    ),
  )
  if ("failed" in outcome) {
    process.stderr.write(`${file} was not changed: ${outcome.failed}\n`)
    process.exit(1)
  }
  const { report } = outcome
  process.stdout.write(
    `rewrote ${file}: ${report.events} events, ${report.written} kept, ${report.dropped} unread replies dropped\n`,
  )
  for (const line of report.expected) process.stdout.write(`  expected: ${line}\n`)
}
