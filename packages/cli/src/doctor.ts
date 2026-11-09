import { connect, type VibestClient, protocolHeaders, readPing, startDaemon } from "@vibest/client/client"
import { HARNESS_IDS } from "@vibest/core/harness"
import { Layout } from "@vibest/core/paths"
import { PROTOCOL } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { Console, Effect, Option } from "effect"
import { Command } from "effect/cli"
import { RpcClient } from "effect/rpc"

import { extraVibests, updateNotice } from "./update.ts"

export type Finding = { readonly mark: "ok" | "problem" | "note"; readonly text: string; readonly fix?: string }
const MARKS = { ok: "✓", problem: "✗", note: "·" } as const

export const doctor = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const sections: Array<{ readonly title: string; readonly findings: ReadonlyArray<Finding> }> = []
    const width = Math.max(...HARNESS_IDS.map((h) => h.length))

    const installs = yield* extraVibests
    if (installs.length > 0) sections.push({ title: "vibest on PATH", findings: installs })

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
    sections.push({ title: "vibestd (the background service)", findings: daemon })

    const harnessNote = (why: string): Finding => ({ mark: "note", text: `not checked: vibestd ${why}` })
    let usable: Array<string> = []
    if (!talks) {
      sections.push({
        title: "Coding agents (the harnesses vibest starts)",
        findings: [harnessNote(ping === undefined ? "is not running" : `speaks protocol ${ping.protocol}`)],
      })
    } else {
      const listed = yield* RpcClient.withHeaders(
        connect(layout.socket).pipe(Effect.flatMap((c) => c["Harnesses.List"]())),
        protocolHeaders(),
      ).pipe(Effect.scoped, Effect.option)
      const harnesses: Array<Finding> = Option.isNone(listed)
        ? [harnessNote("did not answer")]
        : listed.value.map((row) =>
            row.problem
              ? { mark: "problem" as const, text: `${row.harness.padEnd(width)}  ${row.problem}` }
              : {
                  mark: "ok" as const,
                  text: `${row.harness.padEnd(width)}  ${row.models.length} models, default ${row.models.find((m) => m.default)?.model ?? "chosen by the harness"}`,
                },
          )
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
            ...(c.fix ? { fix: c.fix } : {}),
          })
        if (findings.length === 0) findings.push({ mark: "ok", text: "online" })
        sections.push({ title: `Runtime: ${r.name} (where agents run)`, findings })
      }
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
    const problems = sections.flatMap((x) => x.findings).filter((f) => f.mark === "problem").length
    lines.push(
      "",
      problems === 0 ? "Ready." : `${problems} problem${problems === 1 ? "" : "s"}; run the fix lines above.`,
    )
    yield* Console.log(lines.join("\n"))
    yield* updateNotice
  }),
).pipe(
  Command.withDescription(
    "Check that vibest can work here: the coding agents, vibestd, each runtime agents run in, and plugins, each problem with how to fix it; starts vibestd when it is not running",
  ),
)
