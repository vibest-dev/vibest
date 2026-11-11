import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Check } from "../check.ts"
import { ask, heldModel, piDir } from "../fake-model.ts"
import { answerOf, binary, checkout, expect, row, Skip, until, type World } from "../world.ts"
import { dropHerdrSession, project } from "./inbox.ts"
import { setup, type Setup, stopVibestd } from "./machines.ts"

const RELEASE_BEFORE_AGGREGATES = "v0.0.1-beta.19"
const REWRITE = "bun tools/ledger-rewrite/src/main.ts"

const out = (r: { stdout: string; stderr: string }) => `${r.stdout}${r.stderr}`.replace(/\r/g, "")

const latestOf = (stdout: string) => {
  try {
    return (JSON.parse(stdout) as { latest?: { status?: string; summary?: string } | null }).latest ?? undefined
  } catch {
    return undefined
  }
}

const releaseBinary = async (w: World, tag: string) => {
  const archive = `vibest-${process.platform}-${process.arch}.tar.gz`
  const cache = path.join(os.tmpdir(), "vibest-e2e-releases", tag)
  const tarball = path.join(cache, archive)
  if (!(await Bun.file(tarball).exists())) {
    const got = await fetch(`https://github.com/vibest-dev/vibest/releases/download/${tag}/${archive}`)
    expect(got.ok, `downloading ${tag} ${archive}: HTTP ${got.status}`)
    await fs.mkdir(cache, { recursive: true })
    await Bun.write(`${tarball}.part`, got)
    await fs.rename(`${tarball}.part`, tarball)
  }
  const dir = path.join(w.root, `release-${tag}`)
  await fs.mkdir(dir, { recursive: true })
  const unpacked = await w.run(dir, ["tar", "-xzf", tarball])
  expect(unpacked.code === 0, `tar: ${out(unpacked)}`)
  return path.join(dir, "bin", "vibest")
}

type Ran = { code: number; stdout: string; stderr: string }

const namesTheRewrite = (r: Ran) =>
  r.code !== 0 && out(r).includes("is in the old event shape") && out(r).includes(REWRITE)

const rewrite = async (w: World, file: string) => {
  const rewrote = await w.run(checkout, ["bun", "tools/ledger-rewrite/src/main.ts", file], { timeoutMs: 120_000 })
  expect(rewrote.code === 0 && rewrote.stdout.startsWith("rewrote "), `the rewrite of ${file}: ${out(rewrote)}`)
}

const checks: ReadonlyArray<Check> = [
  {
    id: "U13",
    title: `a database written through real sessions by ${RELEASE_BEFORE_AGGREGATES}: this vibestd and vibest daemon import-check refuse it and name ${REWRITE}; after the script vibest ls lists its subagent, vibest result returns its reply, and after vibest daemon restart restarts it on this integration a send reaches it`,
    run: async (w) => {
      for (const bin of ["pi", "herdr"]) if (!Bun.which(bin)) throw new Skip(`${bin} not on PATH`)
      const old = await releaseBinary(w, RELEASE_BEFORE_AGGREGATES)
      const model = heldModel()
      model.release()
      const session = `${w.herdrSession}-u13`
      const repo = await project(w, "u13")
      const pi = `PI_CODING_AGENT_DIR=${await piDir(w, "pi-u13", model.url)}`
      const env = { PATH: `${path.dirname(old)}:${w.env().PATH}` }
      const oldVibest = (args: ReadonlyArray<string>) => w.run(repo, [old, ...args], { env, timeoutMs: 120_000 })
      try {
        await w.stopDaemon()
        const started = await oldVibest(["daemon"])
        await w.ensureHerdr(session)
        expect(started.code === 0, `${RELEASE_BEFORE_AGGREGATES} vibest daemon exited ${started.code}: ${out(started)}`)
        const ran = await oldVibest([
          "run",
          "--runtime",
          "herdr",
          "pi",
          "--session",
          session,
          "--env",
          pi,
          "--",
          ask("before"),
        ])
        expect(ran.code === 0, `${RELEASE_BEFORE_AGGREGATES} vibest run exited ${ran.code}: ${out(ran)}`)
        const sub = (JSON.parse(ran.stdout) as { id: string }).id
        let said = ""
        await until(
          `${RELEASE_BEFORE_AGGREGATES}'s reply`,
          async () => {
            said = out(await oldVibest(["result", sub]))
            const latest = latestOf(said)
            return latest?.status === "completed" && latest.summary === "done-before"
          },
          120_000,
        ).catch((e: Error) => {
          throw new Error(`${e.message}; its vibest result said: ${said}`)
        })
        await w.stopDaemon()

        const file = path.join(w.vibestHome, "vibest.db")
        const refused = await w.vibest(["ls"], { cwd: repo })
        expect(namesTheRewrite(refused), `this vibest on the old database: exit ${refused.code}: ${out(refused)}`)
        const checked = await w.vibest(["daemon", "import-check"], { cwd: repo })
        expect(namesTheRewrite(checked), `import-check on the old database: exit ${checked.code}: ${out(checked)}`)

        await rewrite(w, file)
        await w.ok(["daemon", "import-check"], { cwd: repo })
        await w.ok(["daemon"], { cwd: repo })

        const listed = await w.json<{ sessions: Array<{ id: string }> }>(["ls", "--all"], { cwd: repo })
        expect(
          listed.sessions.some((s) => s.id === sub),
          `vibest ls after the rewrite: ${JSON.stringify(listed)}`,
        )
        expect(
          (await answerOf(w, sub, repo)).includes("done-before"),
          `vibest result after the rewrite: ${await answerOf(w, sub, repo)}`,
        )
        const restarted = await w.tty(["daemon", "restart"], "y\ny\n", { cwd: repo, timeoutMs: 180_000 })
        expect(
          restarted.code === 0 && out(restarted).includes("vibest daemon restart has finished"),
          `vibest daemon restart: exit ${restarted.code}: ${out(restarted)}`,
        )
        const integration = () =>
          row<{ version: string | null }>(
            w,
            "SELECT integration_version AS version FROM process WHERE session_id = ? AND ended_at IS NULL",
            sub,
          )?.version
        await until(
          "the subagent restarted on this integration",
          () => ![undefined, null, RELEASE_BEFORE_AGGREGATES.slice(1)].includes(integration()),
          120_000,
        )
        await w.ok(["send", sub, "--", ask("after")], { cwd: repo })
        await until("the send's reply", async () => (await answerOf(w, sub, repo)).includes("done-after"), 120_000)
      } finally {
        model.stop()
        await w.stopDaemon()
        await dropHerdrSession(w, session)
      }
    },
  },
  {
    id: "U14",
    title: `two vibestds on ${RELEASE_BEFORE_AGGREGATES} over hc with B's notice for A still in B's outbox: after the rewrite of both databases, A gets it once and B's outbox empties`,
    run: async (w) => {
      const old = await releaseBinary(w, RELEASE_BEFORE_AGGREGATES)
      let s: Setup | undefined
      try {
        s = await setup(w, { bin: old })
        await s.okA(["machine", "add", "mb", "b-host"])
        const first = await s.run("heldone")
        await until("B's model got the task", () => s!.subs.asked("heldone"), 120_000)
        await w.stopDaemon()
        s.subs.release("heldone")
        const outbox = () => s!.bDb<{ n: number }>("SELECT count(*) AS n FROM outbox")?.n
        await until("B's outbox row", () => outbox() === 1, 60_000)
        await stopVibestd(s.bEnv.VIBEST_HOME)

        const onA = (args: ReadonlyArray<string>) => w.run(w.repository, [binary, ...args], { env: s!.aEnv })
        const onB = (args: ReadonlyArray<string>) => w.run(s!.bRepo, [binary, ...args], { env: s!.bEnv })
        for (const [name, refused] of [
          ["A", await onA(["ls"])],
          ["B", await onB(["ls"])],
        ] as const)
          expect(namesTheRewrite(refused), `this vibest on ${name}'s old database: ${out(refused)}`)
        await rewrite(w, path.join(w.vibestHome, "vibest.db"))
        await rewrite(w, path.join(s.bEnv.VIBEST_HOME, "vibest.db"))

        const started = await onA(["daemon"])
        expect(started.code === 0, `A: vibest daemon: ${out(started)}`)
        await until("the notice on A", () => s!.notices(first, "heldone") === 1, 120_000)
        await until("B's outbox empty", () => outbox() === 0, 60_000)
        await Bun.sleep(2_000)
        expect(s.notices(first, "heldone") === 1, `the notice arrived ${s.notices(first, "heldone")} times`)
      } finally {
        await s?.stop()
      }
    },
  },
]

export default checks
