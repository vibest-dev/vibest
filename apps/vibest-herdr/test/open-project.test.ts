import { assert, describe, it } from "@effect/vitest"
// `vibest` in a checkout that moved: it asks `[Y/n]` before anything starts. y or Enter moves the project, n makes a
// new one; anything else, EOF or a non-interactive terminal asks vibestd for nothing more.
import { ProjectMoved } from "@vibest/schema/session"
import { Effect, Exit, Sink, Stdio, Stream } from "effect"

import { openProject } from "../src/cli.ts"

const stdio = (terminal: boolean, stdin: Stream.Stream<Uint8Array>, out: Array<string> = []) =>
  Stdio.layerTest({
    stdinIsTerminal: Effect.succeed(terminal),
    stdoutIsTerminal: Effect.succeed(terminal),
    stdin,
    stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => out.push(String(chunk)))),
  })
const typed = (text: string) => Stream.make(new TextEncoder().encode(text))

/** vibestd's answers for a checkout that moved from /old to /new; every `move` it was asked with is recorded. */
const fake = () => {
  const moves: Array<boolean | undefined> = []
  const client = {
    "Project.Open": ({ move }: { move?: boolean }) => {
      moves.push(move)
      return move === undefined
        ? Effect.fail(new ProjectMoved({ projectId: "p", from: "/old", to: "/new" }))
        : Effect.succeed({ projectId: move ? "p" : "q", directory: "/new" })
    },
  } as unknown as Parameters<typeof openProject>[0]
  return { moves, run: openProject(client) }
}

describe("openProject", () => {
  for (const [name, stdin, move, id] of [
    ["y", typed("y\n"), true, "p"],
    ["Enter", typed("\n"), true, "p"],
    ["n", typed("n\n"), false, "q"],
  ] as const)
    it.effect(`${name}: Project.Open again with move ${move}`, () => {
      const out: Array<string> = []
      return Effect.gen(function* () {
        const f = fake()
        assert.strictEqual((yield* f.run).projectId, id)
        assert.deepStrictEqual(f.moves, [undefined, move])
        assert.include(out.join(""), "The project moved from /old to here, move it? [Y/n]: ")
      }).pipe(Effect.provide(stdio(true, stdin, out)))
    })

  for (const [name, terminal, stdin] of [
    ["EOF", true, Stream.empty],
    ["another answer", true, typed("maybe\n")],
    ["not a terminal", false, typed("y\n")],
  ] as const)
    it.effect(`${name}: fails naming both places, nothing changed`, () =>
      Effect.gen(function* () {
        const f = fake()
        const exit = yield* Effect.exit(f.run)
        assert.isTrue(Exit.isFailure(exit))
        assert.include(String(exit), "the project moved from /old to /new")
        assert.deepStrictEqual(f.moves, [undefined])
      }).pipe(Effect.provide(stdio(terminal, stdin))),
    )
})
