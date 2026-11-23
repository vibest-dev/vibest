import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"

import {
  agentDefinitionFindings,
  doctorVerdict,
  plainHarnessProblem,
  runtimeSections,
} from "../src/commands/handlers/doctor.ts"

const signedOut =
  "agy model discovery failed: agy gave no model list: Error: Please sign in to view available models. Launch the CLI without arguments to sign in."

const hcOnline = { kind: "hc", status: "online", name: "herdr-core 0.1.22", checks: [] }

const herdrMissing = {
  kind: "herdr",
  status: "blocked",
  reason: "herdr is not installed",
  name: "herdr",
  checks: [{ ok: false, text: "herdr is not on PATH", fix: "install herdr: https://herdr.dev" }],
}

const hcOffline = {
  kind: "hc",
  status: "offline",
  reason: "no herdr-core answers",
  name: "herdr-core",
  checks: [{ ok: false, text: "herdr-core is not running", fix: "hc server start" }],
}

describe("doctor text", () => {
  it("is Ready with one healthy runtime, and notes the runtimes not installed or not started", () => {
    const sections = runtimeSections([hcOnline, herdrMissing], 0)
    const findings = sections.flatMap((section) => section.findings)

    assert.strictEqual(doctorVerdict(findings), "Ready.")
    assert.deepStrictEqual(sections[0]?.title, "Runtime: herdr-core 0.1.22 (where agents run)")
    assert.deepStrictEqual(
      sections[1]?.findings.map((f) => f.mark),
      ["note", "note"],
    )
  })

  it("reports every runtime as a problem when none is online, so the user sees why nothing can run", () => {
    const findings = runtimeSections([hcOffline, herdrMissing], 0).flatMap((section) => section.findings)

    assert.strictEqual(doctorVerdict(findings), "4 problems; run the fix lines above.")
  })

  it("keeps an online runtime's failing check a problem, and then the offline ones too", () => {
    const herdrHookMissing = {
      kind: "herdr",
      status: "online",
      name: "herdr 0.9.5",
      checks: [{ ok: false, subject: "pi", text: "herdr cannot see its state", fix: "herdr integration install pi" }],
    }

    const findings = runtimeSections([hcOffline, herdrHookMissing], 0).flatMap((section) => section.findings)

    assert.strictEqual(findings.filter((f) => f.mark === "problem").length, 3)
  })

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
