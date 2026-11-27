import childProcess from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Predicate, Schema } from "effect"

import { parsePiTranscript, parseVibestHttpLogs, redactSecrets } from "./metrics.ts"
import type { CommandResult, EvalCliOptions, StoryRunReport, StorySpec } from "./types.ts"

const isJsonObject = Schema.is(Schema.JsonObject)
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..")
const VIBEST_BIN = path.join(REPO_ROOT, "packages/cli/dist/vibest")
const HARNESSES_DIR = path.join(REPO_ROOT, "packages/cli/harnesses")

const shSingle = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const spawnCmd = (
  cwd: string,
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    const child = childProcess.spawn(argv[0]!, argv.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const outChunks: Array<Buffer> = []
    const errChunks: Array<Buffer> = []
    child.stdout.on("data", (b: Buffer) => outChunks.push(b))
    child.stderr.on("data", (b: Buffer) => errChunks.push(b))

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        void 0
      }
    }, timeoutMs)

    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout: Buffer.concat(outChunks).toString("utf8"), stderr: err.message })
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      })
    })
  })

const setupPiSessionDir = async (piDir: string): Promise<void> => {
  await fs.mkdir(path.join(piDir, "sessions"), { recursive: true, mode: 0o700 })
  const userPi = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent")
  const entries = await fs.readdir(userPi, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    if (entry.name === "sessions") continue
    const src = path.join(userPi, entry.name)
    const dst = path.join(piDir, entry.name)

    if (entry.isFile()) {
      await fs.copyFile(src, dst).catch(() => undefined)
    } else {
      await fs.symlink(src, dst).catch(() => undefined)
    }
  }
}

const collectJsonlFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  const out: Array<string> = []

  const walk = async (current: string): Promise<void> => {
    const items = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const item of items) {
      const full = path.join(current, item.name)

      if (item.isDirectory()) {
        await walk(full)
      } else if (item.isFile() && item.name.endsWith(".jsonl")) {
        const text = await fs.readFile(full, "utf8").catch(() => "")

        if (text.trim()) out.push(text)
      }
    }
  }

  await walk(dir)

  return out
}

const teardownWorld = async (
  worldRoot: string,
  extRoot: string,
  vibestHome: string,
  hcSocket: string,
  env: NodeJS.ProcessEnv,
): Promise<void> => {
  const pidText = await fs.readFile(path.join(vibestHome, "vibestd.pid"), "utf8").catch(() => "")

  if (pidText) {
    try {
      const parsed: Schema.Json = JSON.parse(pidText)

      if (isJsonObject(parsed) && Predicate.isNumber(parsed.pid) && parsed.pid > 1) {
        process.kill(parsed.pid, "SIGTERM")
      }
    } catch {
      void 0
    }
  }

  await spawnCmd(worldRoot, ["hc", "server", "stop"], env, 5_000).catch(() => undefined)

  const lsofRes = await spawnCmd(worldRoot, ["lsof", "-t", hcSocket], env, 3_000).catch(() => ({
    code: 1,
    stdout: "",
    stderr: "",
  }))

  for (const token of lsofRes.stdout.split(/\s+/)) {
    const pid = Number(token)

    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      try {
        process.kill(pid, "SIGTERM")
      } catch {
        void 0
      }
    }
  }

  await sleep(400)

  const psRes = await spawnCmd(worldRoot, ["ps", "-eo", "pid=,command="], env, 5_000).catch(() => ({
    code: 1,
    stdout: "",
    stderr: "",
  }))

  for (const line of psRes.stdout.split("\n")) {
    if (!line.includes(worldRoot) && !line.includes(extRoot)) continue
    const pid = Number(line.trim().split(/\s+/)[0])

    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        void 0
      }
    }
  }

  await fs.rm(worldRoot, { recursive: true, force: true }).catch(() => undefined)
  await fs.rm(extRoot, { recursive: true, force: true }).catch(() => undefined)
}

export const runStoryEval = async (story: StorySpec, opts: EvalCliOptions): Promise<StoryRunReport> => {
  const tag = `${story.id.toLowerCase()}-${crypto.randomBytes(3).toString("hex")}`
  const extTag = crypto.randomBytes(6).toString("hex")
  const worldRoot = `/tmp/vbeval-${tag}`
  const extRoot = `/tmp/vbext-${extTag}`
  const vibestHome = path.join(worldRoot, "vh")
  const xdgDir = path.join(worldRoot, "xdg")
  const stateDir = path.join(worldRoot, "state")
  const piDir = path.join(worldRoot, "pi-agent")
  const zdotDir = path.join(worldRoot, "zdot")
  const hcSocket = path.join(worldRoot, "hc.sock")
  const repoDir = path.join(worldRoot, "repo")
  const startedAtMs = Date.now()

  const buildEnv = (): NodeJS.ProcessEnv => {
    const cleanedHost = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          !k.startsWith("ANTIGRAVITY_") &&
          !k.startsWith("CODEX_") &&
          !k.startsWith("CLAUDE_CODE_") &&
          !k.startsWith("VIBEST_") &&
          !k.startsWith("HERDR_"),
      ),
    )

    const base: NodeJS.ProcessEnv = {
      ...cleanedHost,
      VIBEST_HOME: vibestHome,
      VIBEST_HARNESSES: HARNESSES_DIR,
      PI_CODING_AGENT_DIR: piDir,
      HC_SESSION: `eval-${tag}`,
      HC_SOCKET: hcSocket,
      XDG_RUNTIME_DIR: xdgDir,
      XDG_STATE_HOME: stateDir,
      ZDOTDIR: zdotDir,
      VIBEST_NO_UPDATE_CHECK: "1",
      PATH: `${path.dirname(VIBEST_BIN)}:${process.env.PATH ?? ""}`,
      GIT_AUTHOR_NAME: "Eval Developer",
      GIT_AUTHOR_EMAIL: "dev@acme.example",
      GIT_COMMITTER_NAME: "Eval Developer",
      GIT_COMMITTER_EMAIL: "dev@acme.example",
    }

    return Object.fromEntries(Object.entries(base).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])))
  }

  const env = buildEnv()
  const runShell = (cwd: string, argv: ReadonlyArray<string>, timeoutMs = 90_000) => spawnCmd(cwd, argv, env, timeoutMs)
  const runVibest = (args: ReadonlyArray<string>, cwd = repoDir) => runShell(cwd, [VIBEST_BIN, ...args], 90_000)
  let teardownStory: (() => Promise<void>) | undefined

  try {
    for (const d of [vibestHome, xdgDir, stateDir, zdotDir, repoDir, extRoot]) {
      await fs.mkdir(d, { recursive: true })
    }

    await fs.writeFile(
      path.join(zdotDir, ".zshenv"),
      `export PATH=${shSingle(path.dirname(VIBEST_BIN))}:"$PATH"\n`,
      "utf8",
    )

    await setupPiSessionDir(piDir)
    const setupRes = await story.setup(worldRoot, extRoot, repoDir)
    teardownStory = setupRes.teardown

    await fs.writeFile(
      path.join(vibestHome, "mcp.json"),
      `${JSON.stringify({ mcpServers: setupRes.mcpServers }, null, 2)}\n`,
      "utf8",
    )

    for (const gitArgs of [
      ["git", "init", "-q", "-b", "main"],
      ["git", "add", "."],
      ["git", "commit", "-q", "--allow-empty", "-m", "initial project snapshot"],
    ]) {
      const r = await runShell(repoDir, gitArgs)

      if (r.code !== 0) throw new Error(`git setup failed (${story.id}): ${r.stderr}`)
    }

    const hcStart = await runShell(worldRoot, ["hc", "server", "start"])

    if (hcStart.code !== 0) throw new Error(`hc server start failed (${story.id}): ${hcStart.stderr}${hcStart.stdout}`)

    const daemonStart = await runVibest(["daemon"])

    if (daemonStart.code !== 0)
      throw new Error(`vibest daemon failed (${story.id}): ${daemonStart.stderr}${daemonStart.stdout}`)

    for (const seedCmd of setupRes.seedCommands ?? []) {
      const seeded = await runVibest(seedCmd)

      if (seeded.code !== 0) {
        throw new Error(`seed command failed (${story.id}): ${seeded.stderr}${seeded.stdout}`)
      }
    }

    console.log(
      `[${story.id}] Starting isolated ${opts.harness} (agent=${opts.agent}, ${opts.provider}/${opts.model}) session...`,
    )
    const termOpen = await runShell(worldRoot, ["hc", "run", "--bg", "--keep", "--name", "main"])

    if (termOpen.code !== 0) throw new Error(`hc run failed (${story.id}): ${termOpen.stderr}`)

    const launchLine = [
      "cd",
      shSingle(repoDir),
      "&&",
      shSingle(VIBEST_BIN),
      "--agent",
      shSingle(opts.agent),
      "--harness",
      shSingle(opts.harness),
      ...(opts.provider ? ["--provider", shSingle(opts.provider)] : []),
      "--model",
      shSingle(opts.model),
    ].join(" ")

    const termSend = await runShell(worldRoot, ["hc", "send", "main", launchLine])

    if (termSend.code !== 0) throw new Error(`hc send failed (${story.id}): ${termSend.stderr}`)

    let sessionId = ""
    const readyDeadline = Date.now() + 60_000

    while (Date.now() < readyDeadline) {
      await sleep(1_500)
      const lsRes = await runVibest(["ls"])

      if (lsRes.code !== 0) continue

      try {
        const parsed: Schema.Json = JSON.parse(lsRes.stdout)

        if (!isJsonObject(parsed) || !Array.isArray(parsed.sessions) || parsed.sessions.length === 0) continue
        const first = parsed.sessions[0]

        if (isJsonObject(first) && Predicate.isString(first.id) && first.status === "idle") {
          sessionId = first.id
          break
        }
      } catch {
        void 0
      }
    }

    if (!sessionId) throw new Error(`Timed out waiting for session idle in ${story.id}`)

    const sendRes = await runVibest(["send", sessionId, "--", setupRes.prompt])

    if (sendRes.code !== 0) throw new Error(`vibest send failed (${story.id}): ${sendRes.stderr}`)
    console.log(`[${story.id}] Delivered zero-hint user story prompt to ${sessionId.slice(0, 8)}`)

    let finalState = "timeout"
    let quietStreak = 0
    const runDeadline = Date.now() + opts.timeoutSec * 1_000

    while (Date.now() < runDeadline) {
      await sleep(3_000)
      const lsRes = await runVibest(["ls"])

      if (lsRes.code !== 0) continue

      try {
        const parsed: Schema.Json = JSON.parse(lsRes.stdout)

        if (!isJsonObject(parsed) || !Array.isArray(parsed.sessions)) continue
        const found = parsed.sessions.find((item) => isJsonObject(item) && item.id === sessionId)

        if (!isJsonObject(found) || !Predicate.isString(found.executionState)) continue
        const execState = found.executionState

        const anyWorking = parsed.sessions.some(
          (item) => isJsonObject(item) && (item.status === "working" || item.executionState === "open"),
        )

        if ((execState === "completed" || execState === "failed" || execState === "interrupted") && !anyWorking) {
          quietStreak += 1

          if (quietStreak >= 2) {
            finalState = execState
            break
          }
        } else {
          quietStreak = 0
        }
      } catch {
        void 0
      }
    }

    const resOut = await runVibest(["result", sessionId])
    let replyText = ""

    try {
      const parsedRes: Schema.Json = JSON.parse(resOut.stdout)

      if (isJsonObject(parsedRes) && isJsonObject(parsedRes.reply) && Predicate.isString(parsedRes.reply.text)) {
        replyText = redactSecrets(parsedRes.reply.text)
      }
    } catch {
      void 0
    }

    const logText = await fs.readFile(path.join(vibestHome, "vibestd.log"), "utf8").catch(() => "")
    const httpLogs = parseVibestHttpLogs(logText)
    const spillFiles = await fs.readdir(path.join(vibestHome, "tool-output")).catch(() => [])
    const jsonlDocs = await collectJsonlFiles(path.join(piDir, "sessions"))
    const { turns, metrics } = parsePiTranscript(jsonlDocs, httpLogs, spillFiles)

    const checks = await story.grade({
      worldRoot,
      extRoot,
      repoDir,
      vibestHome,
      sessionId,
      finalState,
      replyText,
      metrics,
      turns,
      httpLogs,
      runVibest,
      runShell,
    })

    const durationMs = Date.now() - startedAtMs
    const requiredChecks = checks.filter((c) => c.required)
    const bonusChecks = checks.filter((c) => !c.required)
    const requiredPassed = requiredChecks.filter((c) => c.passed).length
    const bonusPassed = bonusChecks.filter((c) => c.passed).length
    const passed = requiredPassed === requiredChecks.length

    console.log(
      `[${story.id}] ${passed ? "PASS" : "FAIL"} (${requiredPassed}/${requiredChecks.length} required, ${metrics.assistantTurns} turns, ${metrics.totalTokens} tokens, ${(durationMs / 1_000).toFixed(1)}s)`,
    )

    return {
      id: story.id,
      slug: story.slug,
      title: story.title,
      personaGoal: story.personaGoal,
      prompt: setupRes.prompt,
      groundTruthSummary: setupRes.groundTruthSummary,
      sessionId,
      finalState,
      durationMs,
      passed,
      requiredPassed,
      requiredTotal: requiredChecks.length,
      bonusPassed,
      bonusTotal: bonusChecks.length,
      checks,
      metrics,
      replyText,
      turns,
      httpLogs,
    }
  } finally {
    await teardownStory?.().catch(() => undefined)
    await teardownWorld(worldRoot, extRoot, vibestHome, hcSocket, env)
  }
}
