import { assert, it } from "@effect/vitest"
import { ProjectMoved } from "@vibest/schema/session"
import { Effect, Exit, Sink, Stdio, Stream } from "effect"

import { openProject } from "../src/open-project.ts"

const typed = (text: string) => Stream.make(new TextEncoder().encode(text))

it.effect(
  "openProject in a moved checkout asks [Y/n]: only Enter or n calls Project.Open again, anything else changes nothing",
  () =>
    Effect.gen(function* () {
      for (const [terminal, stdin, again] of [
        [true, typed("\n"), true],
        [true, typed("n\n"), false],
        [true, Stream.empty, undefined],
        [true, typed("maybe\n"), undefined],
        [false, typed("y\n"), undefined],
      ] as const) {
        const moves: Array<boolean | undefined> = []
        const out: Array<string> = []
        const client = {
          "Project.Open": ({ move }: { move?: boolean }) => {
            moves.push(move)
            return move === undefined
              ? Effect.fail(new ProjectMoved({ projectId: "p", from: "/old", to: "/new" }))
              : Effect.succeed({ projectId: move ? "p" : "q", directory: "/new" })
          },
        } as unknown as Parameters<typeof openProject>[0]
        const layer = Stdio.layerTest({
          stdinIsTerminal: Effect.succeed(terminal),
          stdoutIsTerminal: Effect.succeed(terminal),
          stdin,
          stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => out.push(String(chunk)))),
        })
        const exit = yield* Effect.exit(openProject(client)).pipe(Effect.provide(layer))
        const what = `${terminal} ${again}`
        if (again === undefined) {
          assert.isTrue(Exit.isFailure(exit), what)
          assert.include(String(exit), "the project moved from /old to /new")
          assert.deepStrictEqual(moves, [undefined], what)
        } else {
          assert.isTrue(Exit.isSuccess(exit), what)
          assert.deepStrictEqual(moves, [undefined, again], what)
          assert.include(out.join(""), "The project moved from /old to here, move it? [Y/n]: ")
        }
      }
    }),
)
