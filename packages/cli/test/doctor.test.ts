import { assert, describe, it } from "@effect/vitest"

import { doctorVerdict, plainHarnessProblem } from "../src/commands/handlers/doctor.ts"

const signedOut =
  "agy model discovery failed: agy gave no model list: Error: Please sign in to view available models. Launch the CLI without arguments to sign in."

describe("doctor text", () => {
  it("shows a signed-out harness once, with the sign-in line under it", () => {
    assert.deepStrictEqual(plainHarnessProblem("agy", signedOut), {
      text: "not signed in",
      fix: "run agy once to sign in",
    })
    assert.deepStrictEqual(
      plainHarnessProblem(
        "agy",
        "agy model discovery failed: agyx gave no model list: Error: Please sign in to view available models.",
      ),
      { text: "not signed in", fix: "run agy once to sign in" },
    )
  })

  it("shows one discovery failure, without repeating the harness or its Error label", () => {
    assert.deepStrictEqual(
      plainHarnessProblem("agy", "agy model discovery failed: agy gave no model list: Error: connection reset"),
      { text: "connection reset" },
    )
    assert.deepStrictEqual(
      plainHarnessProblem("agy", "agy model discovery failed: agyx did not list its models: Error: timed out"),
      { text: "timed out" },
    )
  })

  it("leaves a missing binary and a missing plugin as doctor received them", () => {
    assert.deepStrictEqual(plainHarnessProblem("agy", "agy is not on PATH"), { text: "agy is not on PATH" })
    assert.deepStrictEqual(plainHarnessProblem("pi", "vibest's pi plugin is missing: /harnesses/pi"), {
      text: "vibest's pi plugin is missing: /harnesses/pi",
    })
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
      doctorVerdict([{ mark: "problem", text: "not signed in", fix: "run agy once to sign in" }]),
      "1 problem; run the fix lines above.",
    )
    assert.strictEqual(
      doctorVerdict([
        { mark: "problem", text: "not signed in", fix: "run agy once to sign in" },
        { mark: "problem", text: "herdr is not on PATH", fix: "install herdr: https://herdr.dev" },
      ]),
      "2 problems; run the fix lines above.",
    )
  })
})
