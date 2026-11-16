import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import url from "node:url"

import { describe, expect, it } from "vitest"

const root = url.fileURLToPath(new URL("../..", import.meta.url))

const configAt = (dir) => {
  const config = JSON.parse(fs.readFileSync(path.join(root, ".oxlintrc.json"), "utf8"))
  const absolute = (specifier) => path.join(root, specifier)
  config.jsPlugins = config.jsPlugins.map((plugin) =>
    typeof plugin === "string" ? absolute(plugin) : { ...plugin, specifier: absolute(plugin.specifier) },
  )
  const file = path.join(dir, "oxlintrc.json")
  fs.writeFileSync(file, JSON.stringify(config))
  return file
}

const oxlintFindings = (source, file = "fixture.ts", { scoped = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-oxlint-"))
  try {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), source)
    const run = childProcess.spawnSync(
      path.join(root, "node_modules/.bin/oxlint"),
      ["-c", scoped ? configAt(dir) : path.join(root, ".oxlintrc.json"), "-f", "json", dir],
      { encoding: "utf8" },
    )
    return JSON.parse(run.stdout)
      .diagnostics.map((d) => `${d.labels[0].span.line} ${d.code}`)
      .sort()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("node-import-style", () => {
  it("accepts default imports under their canonical names, and type-only imports", () => {
    expect(
      oxlintFindings(`import childProcess from "node:child_process"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import type { Stats } from "node:fs"
import { type Dirent } from "node:fs"
export type { Stats } from "node:fs"
export { type Stats as FsStats } from "node:fs"
export const all = [childProcess, fs, fsPromises] as unknown as [Stats, Dirent]
`),
    ).toEqual([])
  })

  it("rejects named and namespace imports", () => {
    expect(
      oxlintFindings(`import { readFileSync } from "node:fs"
import * as path from "node:path"
export const all = [readFileSync, path]
`),
    ).toEqual(["1 vibest(node-import-style)", "2 vibest(node-import-style)"])
  })

  it("rejects ad-hoc names, and the short name for a subpath when its parent is imported too", () => {
    expect(
      oxlintFindings(`import nodePath from "node:path"
import fs from "node:fs"
import fsp from "node:fs/promises"
export const all = [nodePath, fs, fsp]
`),
    ).toEqual(["1 vibest(node-import-style)", "3 vibest(node-import-style)"])
  })

  it("rejects re-exports from builtins", () => {
    expect(
      oxlintFindings(`export { readFileSync } from "node:fs"
export * from "node:path"
`),
    ).toEqual(["1 vibest(node-import-style)", "2 vibest(node-import-style)"])
  })
})

describe("no-restricted-disable", () => {
  it.each([
    "unicorn/prefer-node-protocol",
    "prefer-node-protocol",
    "node/prefer-node-protocol",
    "eslint-plugin-unicorn/prefer-node-protocol",
  ])("refuses disabling %s", (rule) => {
    expect(
      oxlintFindings(`// oxlint-disable-next-line ${rule}
import os from "os"
export const cpus = os.cpus()
`),
    ).toContain("1 vibest(no-restricted-disable)")
  })

  it.each(["eslint/max-lines", "max-lines", "oxc/max-lines"])(
    "refuses disabling %s on a file over the limit",
    (rule) => {
      const body = Array.from({ length: 1001 }, (_, i) => `export const line${i} = ${i}`).join("\n")
      expect(oxlintFindings(`/* oxlint-disable ${rule} */\n${body}\n`)).toContain("1 vibest(no-restricted-disable)")
    },
  )

  it.each(["event-reads", "no-payload-sql", "projector-writes", "no-background-loop"])(
    "refuses disabling vibest/%s",
    (rule) => {
      expect(oxlintFindings(`// oxlint-disable-next-line vibest/${rule}\nexport const one = 1\n`)).toContain(
        "1 vibest(no-restricted-disable)",
      )
    },
  )

  it("refuses a blanket disable", () => {
    expect(oxlintFindings(`// eslint-disable\nexport const one = 1\n`)).toEqual(["1 vibest(no-restricted-disable)"])
  })

  it("allows disabling other rules", () => {
    expect(oxlintFindings(`// oxlint-disable-next-line eslint/no-unused-vars -- fixture\nconst unused = 1\n`)).toEqual(
      [],
    )
  })
})

describe("no-comments", () => {
  it("reports line, block and JSDoc comments", () => {
    expect(
      oxlintFindings(`// a line comment
/* a block comment */
/** a JSDoc comment */
export const one = 1 // a trailing comment
`),
    ).toEqual(["1 vibest(no-comments)", "2 vibest(no-comments)", "3 vibest(no-comments)", "4 vibest(no-comments)"])
  })

  it("allows a shebang, TypeScript directives, triple-slash references and lint directives", () => {
    expect(
      oxlintFindings(`#!/usr/bin/env bun
/// <reference types="node" />
// @ts-expect-error the fixture assigns a number to a string
export const name: string = 1
// @ts-ignore
export const other: string = 2
// oxlint-disable-next-line eslint/no-unused-vars -- fixture
const unused = 1
/* oxlint-disable-next-line eslint/no-unused-vars -- fixture */
const unusedToo = 1
/** @ts-expect-error the fixture assigns a number to a string */
export const third: string = 3
`),
    ).toEqual([])
  })

  it("allows oxlint-enable and eslint-enable directives, with or without rules", () => {
    expect(
      oxlintFindings(`/* oxlint-disable eslint/no-unused-vars */
const unused = 1
/* oxlint-enable eslint/no-unused-vars */
// eslint-disable-next-line eslint/no-unused-vars -- fixture
const unusedToo = 1
// eslint-enable
// oxlint-enable
export const one = 1
`),
    ).toEqual([])
  })

  it("still reports a comment that only mentions a directive", () => {
    expect(oxlintFindings(`// remember to oxlint-enable later\nexport const one = 1\n`)).toEqual([
      "1 vibest(no-comments)",
    ])
  })
})

describe("import policy", () => {
  const importing = (specifier) => `import * as m from "${specifier}"\nexport const v = m\n`
  const herdr = importing("effect-herdr-sdk")
  const bun = importing("bun:sqlite")
  const core = importing("@vibest/core/x")
  const scopedFindings = (source, file) => oxlintFindings(source, file, { scoped: true })
  const refused = ["1 eslint(no-restricted-imports)"]
  const outside = ["1 vibest(package-imports)"]

  it("neutral packages refuse herdr and Bun; bun.ts and platform/ accept Bun but not herdr", () => {
    for (const file of ["a.ts", "bun.ts", "platform/a.ts"]) {
      const path = `packages/core/src/${file}`
      expect(scopedFindings(herdr, path)).toEqual(outside)
      expect(scopedFindings(bun, path)).toEqual(file === "a.ts" ? refused : [])
    }
  })

  it.each(["integration/claude", "plugin-harnesses", "runtime-herdr", "runtime-herdr-core"])(
    "%s refuses @vibest/core and Bun; bun.ts and platform/ accept only Bun",
    (root) => {
      for (const file of ["a.ts", "bun.ts", "platform/a.ts"]) {
        const path = `packages/${root}/src/${file}`
        expect(scopedFindings(core, path)).toEqual(outside)
        expect(scopedFindings(bun, path)).toEqual(file === "a.ts" ? refused : [])
      }
    },
  )

  it("the herdr SDKs and tools/verify refuse Bun outside bun.ts and platform/", () => {
    for (const file of ["packages/effect-herdr-sdk/src/bun.ts", "packages/effect-herdr-core-sdk/src/platform/a.ts"])
      expect(scopedFindings(bun, file)).toEqual([])
    for (const file of ["packages/effect-herdr-sdk/src/a.ts", "tools/verify/src/a.ts"])
      expect(scopedFindings(bun, file)).toEqual(refused)
  })

  it("the CLI refuses @vibest/core and herdr in every source file", () => {
    expect(scopedFindings(core, "packages/cli/src/a.ts")).toEqual(outside)
    expect(scopedFindings(herdr, "packages/cli/src/a.ts")).toEqual(outside)
    expect(scopedFindings(core, "packages/cli/src/commands/handlers/a.ts")).toEqual(outside)
  })
})

describe("ledger access rules", () => {
  const core = (name) => `packages/core/src/${name}`

  it("event-reads: only the bus reads the event table and position", () => {
    const source = "export const q = `SELECT * FROM event`\nexport const p = { position: 1 }\n"
    expect(oxlintFindings(source, core("a.ts"))).toEqual(["1 vibest(event-reads)", "2 vibest(event-reads)"])
    expect(oxlintFindings(source, core("bus.ts"))).toEqual([])
    expect(oxlintFindings(source, core("a.test.ts"))).toEqual([])
  })

  it("no-payload-sql: json_extract only in the v1 import", () => {
    const source = `export const q = "SELECT json_extract(data, '$.a') FROM x"\n`
    expect(oxlintFindings(source, core("a.ts"))).toEqual(["1 vibest(no-payload-sql)"])
    expect(oxlintFindings(source, core("import/v1.ts"))).toEqual([])
  })

  it("projector-writes: statements and builder calls only in the writers", () => {
    const source = `export const a = "INSERT INTO t VALUES (1)"\nexport const b = sql.insert("session")\nexport const c = "UPDATE t SET a = 1"\nexport const d = this.sql.update("t")\n`
    expect(oxlintFindings(source, core("a.ts"))).toEqual([
      "1 vibest(projector-writes)",
      "2 vibest(projector-writes)",
      "3 vibest(projector-writes)",
      "4 vibest(projector-writes)",
    ])
    expect(oxlintFindings(source, core("session/projector.ts"))).toEqual([])
  })

  it("projector-writes: db.ts may hold only its one opening write", () => {
    const opening = "export const a = `UPDATE meta SET value = value WHERE key = ''`\n"
    expect(oxlintFindings(opening, core("database/db.ts"))).toEqual([])
    expect(oxlintFindings(opening + opening.replace("const a", "const b"), core("database/db.ts"))).toEqual([
      "2 vibest(projector-writes)",
    ])
    expect(oxlintFindings(`export const a = "DELETE FROM meta"\n`, core("database/db.ts"))).toEqual([
      "1 vibest(projector-writes)",
    ])
  })

  it("no-background-loop: unbounded loops in core and server only", () => {
    const source = `import { Effect, Stream } from "effect"
export const a = Effect.forever(Effect.void)
export const b = setInterval(() => {}, 1)
export const c = Stream.tick("1 second")
export const d = Effect.repeat(Effect.void, { times: 3 })
export const e = Effect.repeat(Effect.void, { until: () => true })
export const f = Effect.repeat(Effect.void, Schedule.spaced("1 second"))
export const g = Effect.schedule(Effect.void, Schedule.spaced("1 second"))
export const h = globalThis.setInterval
export const i = setInterval
`
    expect(oxlintFindings(source, "packages/server/src/a.ts")).toEqual([
      "10 vibest(no-background-loop)",
      "2 vibest(no-background-loop)",
      "3 vibest(no-background-loop)",
      "4 vibest(no-background-loop)",
      "7 vibest(no-background-loop)",
      "8 vibest(no-background-loop)",
      "9 vibest(no-background-loop)",
    ])
    expect(oxlintFindings(source, "packages/client/src/a.ts")).toEqual([])
  })

  it("no-background-loop: the approved file keeps only its one loop", () => {
    const forever = "export const a = pipe(x, Effect.forever)\n"
    expect(oxlintFindings(forever, "packages/core/src/plugin/supervisor.ts")).toEqual([])
    expect(
      oxlintFindings(forever + forever.replace("const a", "const b"), "packages/core/src/plugin/supervisor.ts"),
    ).toEqual(["2 vibest(no-background-loop)"])
  })
})

describe("no-module-let", () => {
  it("reports module-level let, exported or not, and allows let inside functions and const", () => {
    expect(
      oxlintFindings(`let one = 0
export let two = 0
export const three = () => {
  let inner = 0
  inner += 1
  return inner
}
export const bump = () => ++one + two
`),
    ).toEqual(["1 vibest(no-module-let)", "2 vibest(no-module-let)"])
  })
})

describe("package-imports", () => {
  it("checks dynamic imports, type queries, re-exports and relative paths that leave the package", () => {
    const source = `import * as a from "./a.ts"
import * as b from "../../server/src/server.ts"
export * from "../../../packages/core/src/bus.ts"
export type C = import("../../server/src/server.ts").C
export type D = typeof import("@vibest/client/client")
export const e = [a, b, import("@vibest/protocol/rpc"), import("@vibest/schema/id")]
export { f } from "@vibest/server/server"
`
    expect(oxlintFindings(source, "packages/core/src/x.ts")).toEqual([
      "2 vibest(package-imports)",
      "4 vibest(package-imports)",
      "5 vibest(package-imports)",
      "6 vibest(package-imports)",
      "7 vibest(package-imports)",
    ])
  })

  it("lets only the daemon handler take HANDOFF_ENV, by a named static import, from @vibest/server/server", () => {
    const handler = "packages/cli/src/commands/handlers/daemon/default.ts"
    const named = `import { HANDOFF_ENV } from "@vibest/server/server"\nexport const v = HANDOFF_ENV\n`
    expect(oxlintFindings(named, handler)).toEqual([])
    expect(oxlintFindings(named, "packages/cli/src/commands/handlers/status.ts")).toEqual(["1 vibest(package-imports)"])
    for (const other of [
      `import { layer } from "@vibest/server/server"\nexport const v = layer\n`,
      `import * as Server from "@vibest/server/server"\nexport const v = Server\n`,
      `import { HANDOFF_ENV, layer } from "@vibest/server/server"\nexport const v = [HANDOFF_ENV, layer]\n`,
      `export const v = import("@vibest/server/server")\n`,
      `export const v = import(\`@vibest/server/server\`)\n`,
      `import { x } from "@vibest/server/server/x"\nexport const v = x\n`,
    ])
      expect(oxlintFindings(other, handler)).toEqual(["1 vibest(package-imports)"])
  })
})
