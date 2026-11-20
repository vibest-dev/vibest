import { connect, type VibestClient, protocolHeaders, readPing, startDaemon } from "@vibest/client/client"
import { Layout } from "@vibest/schema/layout"
import type { AgentListing } from "@vibest/schema/session"
import { PROTOCOL } from "@vibest/schema/version"
import { Console, Effect, Option } from "effect"
import { RpcClient } from "effect/rpc"

import { Runtime } from "../../framework/runtime.ts"
import { extraVibests, type Finding, updateNotice } from "../../update.ts"
import { VERSION } from "../../version.ts"
import { Commands } from "../commands.ts"

const MARKS = { ok: "✓", problem: "✗", note: "·" } as const

export const plainHarnessProblem = (harness: string, problem: string) => {
  const failed = `${harness} model discovery failed: `
  const discovered = problem.startsWith(failed) ? problem.slice(failed.length) : problem
  const reported = discovered.replace(/^\S+ gave no model list: /, "").replace(/^\S+ did not list its models: /, "")

  return reported === "" ? problem : reported
}

export const doctorVerdict = (findings: ReadonlyArray<Finding>) => {
  const problems = findings.filter((f) => f.mark === "problem")

  if (problems.length === 0) return "Ready."

  const word = `${problems.length} problem${problems.length === 1 ? "" : "s"}`

  return problems.some((f) => f.fix) ? `${word}; run the fix lines above.` : `${word}.`
}

export const agentDefinitionFindings = <E, R>(
  listed: boolean,
  list: Effect.Effect<Option.Option<AgentListing>, E, R>,
): Effect.Effect<ReadonlyArray<Finding>, E, R> =>
  listed
    ? Effect.map(list, (definitions) =>
        Option.match(definitions, {
          onNone: (): Array<Finding> => [{ mark: "note", text: "vibestd did not list its agent definitions" }],
          onSome: (listing): Array<Finding> => [
            { mark: "ok", text: listing.agents.map((agent) => agent.id).join(", ") },
            ...listing.invalid.map((agent): Finding => ({
              mark: "problem",
              text: `${agent.id ?? agent.source}: ${agent.error}`,
              fix: `fix or remove ${agent.source}`,
            })),
          ],
        }),
      )
    : Effect.succeed([
        { mark: "problem", text: "this vibestd is older and does not list agent definitions", fix: "vibest update" },
      ])

export default Runtime.handler(Commands.commands.doctor, () =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const sections: Array<{ readonly title: string; readonly findings: ReadonlyArray<Finding> }> = []
    let width = 0

    const installs = yield* extraVibests

    if (installs.length > 0) sections.push({ title: "Installs (vibest on PATH)", findings: installs })

    const daemon: Array<Finding> = []
    let ping = Option.getOrUndefined(yield* readPing(layout.socket))

    if (ping === undefined) {
      const started = yield* startDaemon.pipe(
        Effect.as(true),
        Effect.catch((e) => Effect.succeed(e.message)),
      )

      ping = Option.getOrUndefined(yield* readPing(layout.socket))

      if (ping === undefined)
        daemon.push({
          mark: "problem",
          text: `not running and did not start: ${started === true ? "no answer" : started}`,
          fix: `see ${layout.home}/vibestd.log`,
        })
      else daemon.push({ mark: "note", text: "was not running; started it" })
    }

    const talks = ping !== undefined && ping.protocol === PROTOCOL

    if (ping !== undefined && !talks)
      daemon.push({
        mark: "problem",
        text: `running ${ping.version}${ping.pid ? ` (pid ${ping.pid})` : ""}, a build this vibest ${VERSION} cannot talk to; runtimes and plugins are not checked`,
        fix: "vibest daemon restart",
      })
    else if (ping !== undefined) {
      daemon.push({ mark: "ok", text: `running ${ping.version}${ping.pid ? ` (pid ${ping.pid})` : ""}` })

      if (ping.version !== VERSION)
        daemon.push({ mark: "note", text: `this vibest is ${VERSION}; to run it instead: vibest daemon restart` })
    }

    sections.push({ title: "Background service (vibestd)", findings: daemon })

    const harnessNote = (why: string): Finding => ({ mark: "note", text: `not checked: vibestd ${why}` })
    let usable: Array<string> = []

    if (!talks) {
      sections.push({
        title: "Coding agents (the harnesses vibest starts)",
        findings: [harnessNote(ping === undefined ? "is not running" : `speaks protocol ${ping.protocol}`)],
      })
    } else {
      const listed = yield* RpcClient.withHeaders(
        connect(layout.socket).pipe(Effect.flatMap((c) => c["Harnesses.List"]({}))),
        protocolHeaders(),
      ).pipe(Effect.scoped, Effect.option)

      if (Option.isSome(listed)) width = Math.max(0, ...listed.value.map((row) => row.harness.length))

      const harnesses: Array<Finding> = Option.isNone(listed)
        ? [harnessNote("did not answer")]
        : listed.value.map((row) => {
            if (row.problem === null)
              return {
                mark: "ok" as const,
                text: `${row.harness.padEnd(width)}  ${row.models.length} models, default ${row.models.find((m) => m.default)?.model ?? "chosen by the harness"}`,
              }

            return {
              mark: "problem" as const,
              text: `${row.harness.padEnd(width)}  ${plainHarnessProblem(row.harness, row.problem)}`,
            }
          })

      if (Option.isSome(listed)) usable = listed.value.filter((row) => row.problem === null).map((row) => row.harness)
      sections.push({ title: "Coding agents (the harnesses vibest starts)", findings: harnesses })
    }

    if (talks) {
      const ask = <A, E>(f: (c: VibestClient) => Effect.Effect<A, E>) =>
        RpcClient.withHeaders(connect(layout.socket).pipe(Effect.flatMap(f)), protocolHeaders()).pipe(
          Effect.scoped,
          Effect.option,
        )

      const runtimes = yield* ask((c) => c["Runtimes.Doctor"]({ harnesses: usable }))

      if (Option.isNone(runtimes) || runtimes.value.length === 0)
        sections.push({
          title: "Runtimes (where agents run)",
          findings: [
            {
              mark: "problem",
              text: Option.isNone(runtimes)
                ? "vibestd did not list its runtimes"
                : "none loaded; agents have nowhere to run",
              fix: "vibest plugins",
            },
          ],
        })

      for (const r of Option.getOrElse(runtimes, () => [])) {
        const findings: Array<Finding> =
          r.status === "online" ? [] : [{ mark: "problem", text: `${r.status}: ${r.reason ?? "unknown"}` }]

        for (const c of r.checks)
          findings.push({
            mark: c.ok ? "ok" : "problem",
            text: c.subject ? `${c.subject.padEnd(width)}  ${c.text}` : c.text,
            ...(c.fix && { fix: c.fix }),
          })

        if (findings.length === 0) findings.push({ mark: "ok", text: "online" })
        sections.push({ title: `Runtime: ${r.name} (where agents run)`, findings })
      }

      sections.push({
        title: "Agent definitions",
        findings: yield* agentDefinitionFindings(
          ping?.capabilities?.agents === true,
          ask((c) => c["Agents.List"]({})),
        ),
      })

      const loaded = yield* ask((c) => c.Plugins())
      sections.push({
        title: "Plugins",
        findings: Option.match(loaded, {
          onNone: (): Array<Finding> => [{ mark: "note", text: "vibestd did not list its plugins" }],
          onSome: (all): Array<Finding> => [
            ...(all.some((p) => p.status === "active")
              ? [
                  {
                    mark: "ok" as const,
                    text: `active: ${all
                      .filter((p) => p.status === "active")
                      .map((p) => p.id)
                      .join(", ")}`,
                  },
                ]
              : []),
            ...all
              .filter((p) => p.status === "failed")
              .map((p): Finding => ({
                mark: "problem",
                text: `${p.id}: ${p.error ?? "failed"}`,
                fix: `fix or remove ${p.source}`,
              })),
          ],
        }),
      })
    }

    const lines = [`vibest ${VERSION}`]

    for (const section of sections) {
      lines.push("", section.title)

      for (const f of section.findings) {
        lines.push(`  ${MARKS[f.mark]} ${f.text}`)

        if (f.fix) lines.push(`      fix: ${f.fix}`)
      }
    }

    lines.push("", doctorVerdict(sections.flatMap((section) => section.findings)))
    yield* Console.log(lines.join("\n"))
    yield* updateNotice
  }),
)
