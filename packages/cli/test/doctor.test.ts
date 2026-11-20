import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"

import { agentDefinitionFindings, doctorVerdict, plainHarnessProblem } from "../src/commands/handlers/doctor.ts"

const signedOut =
  "agy model discovery failed: agy gave no model list: Error: Please sign in to view available models. Launch the CLI without arguments to sign in."

describe("doctor text", () => {
  it("shows the harness message once, without guessing what it means", () => {
    assert.strictEqual(
      plainHarnessProblem("agy", signedOut),
      "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.",
    )
    assert.strictEqual(
      plainHarnessProblem(
        "agy",
        "agy model discovery failed: agyx gave no model list: Error: Please sign in to view available models.",
      ),
      "Error: Please sign in to view available models.",
    )
  })

  it("drops only the wrappers vibest adds, and keeps the harness text", () => {
    assert.strictEqual(
      plainHarnessProblem("agy", "agy model discovery failed: agy gave no model list: Error: connection reset"),
      "Error: connection reset",
    )
    assert.strictEqual(
      plainHarnessProblem("agy", "agy model discovery failed: agyx did not list its models: Error: timed out"),
      "Error: timed out",
    )
  })

  it("leaves a missing binary and a missing plugin as doctor received them", () => {
    assert.strictEqual(plainHarnessProblem("agy", "agy is not on PATH"), "agy is not on PATH")
    assert.strictEqual(
      plainHarnessProblem("pi", "vibest's pi plugin is missing: /harnesses/pi"),
      "vibest's pi plugin is missing: /harnesses/pi",
    )
  })

  it("tells you to run the fix lines only when one was printed", () => {
    assert.strictEqual(doctorVerdict([]), "Ready.")
    assert.strictEqual(
      doctorVerdict([
        { mark: "ok", text: "running" },
        { mark: "note", text: "started" },
      ]),
      "Ready.",
    )
    assert.strictEqual(doctorVerdict([{ mark: "problem", text: "agy is not on PATH" }]), "1 problem.")
    assert.strictEqual(
      doctorVerdict([{ mark: "problem", text: "running an older build", fix: "vibest daemon restart" }]),
      "1 problem; run the fix lines above.",
    )
    assert.strictEqual(
      doctorVerdict([
        { mark: "problem", text: "agy is not on PATH" },
        { mark: "problem", text: "herdr is not on PATH", fix: "install herdr: https://herdr.dev" },
      ]),
      "2 problems; run the fix lines above.",
    )
  })
})

describe("doctor agent definitions", () => {
  it.effect("a vibestd without the agents capability is not asked, and the section says to update", () =>
    Effect.gen(function* () {
      const findings = yield* agentDefinitionFindings(false, Effect.die("Unknown request tag: Agents.List"))
      assert.deepStrictEqual(findings, [
        { mark: "problem", text: "this vibestd is older and does not list agent definitions", fix: "vibest update" },
      ])

      const listed = yield* agentDefinitionFindings(
        true,
        Effect.succeed(Option.some({ agents: [], invalid: [{ source: "/a", error: "e", plugin: "p" }] })),
      )

      assert.deepStrictEqual(listed[1], { mark: "problem", text: "/a: e", fix: "fix or remove /a" })
    }),
  )
})
