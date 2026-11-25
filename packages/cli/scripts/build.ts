import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import pkg from "../package.json" with { type: "json" }

const rawArgs = process.argv.slice(2)
const noBytecode = rawArgs.includes("--no-bytecode")
const positional = rawArgs.filter((arg) => arg !== "--no-bytecode")
const [outfile = "dist/vibest", target] = positional
const cliDir = path.dirname(import.meta.dir)

const PGO_STEPS: ReadonlyArray<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [
  { name: "version", args: ["--version"] },
  { name: "help", args: ["--help"] },
  { name: "daemon", args: ["daemon"] },
  { name: "status", args: ["status"] },
  { name: "ls", args: ["ls"] },
  { name: "plugins", args: ["plugins"] },
  { name: "import-check", args: ["daemon", "import-check"] },
]

const PGO_PRIORITY = ["version", "status", "ls", "plugins", "daemon", "import-check", "help"] as const

const SIGNALS: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
  ["SIGHUP", 1],
  ["SIGINT", 2],
  ["SIGTERM", 15],
]

const compileArgs = (out: string, extra: ReadonlyArray<string>): ReadonlyArray<string> => [
  "build",
  "--compile",
  "./src/main.ts",
  "--outfile",
  out,
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-dotenv",
  "--define",
  `VIBEST_VERSION=${JSON.stringify(pkg.version)}`,
  ...extra,
]

const isolatedEnv = (pgoHome: string) =>
  Object.fromEntries([
    ...Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("VIBEST_") && key !== "BUN_BYTECODE_ORDER_OUT",
    ),
    ["VIBEST_HOME", pgoHome],
  ])

const readDaemonPid = (pgoHome: string): number | undefined => {
  const pidFile = path.join(pgoHome, "vibestd.pid")

  if (!fs.existsSync(pidFile)) return undefined

  const match = /"pid"\s*:\s*(\d+)/.exec(fs.readFileSync(pidFile, "utf8"))

  return match ? Number(match[1]) : undefined
}

const stopTempDaemon = (pgoHome: string) => {
  const pid = readDaemonPid(pgoHome)

  if (pid === undefined) return

  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }

  for (let i = 0; i < 60; i++) {
    try {
      process.kill(pid, 0)
      Bun.sleepSync(50)
    } catch {
      return
    }
  }

  try {
    process.kill(pid, "SIGKILL")
  } catch {
    return
  }
}

const buildWithPgo = async (): Promise<number> => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpgo-"))
  const pgoHome = path.join(tempDir, "h")
  fs.mkdirSync(pgoHome, { recursive: true })

  let activeChild: Bun.Subprocess | undefined
  let cleaned = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    stopTempDaemon(pgoHome)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  const runBun = async (args: ReadonlyArray<string>): Promise<number> => {
    const proc = Bun.spawn([process.execPath, ...args], {
      cwd: cliDir,
      stdio: ["inherit", "inherit", "inherit"],
    })

    activeChild = proc

    try {
      return await proc.exited
    } finally {
      activeChild = undefined
    }
  }

  const runProbe = async (
    probeBin: string,
    args: ReadonlyArray<string>,
    env: Record<string, string>,
  ): Promise<{ readonly exitCode: number; readonly stderr: string }> => {
    const proc = Bun.spawn([probeBin, ...args], {
      cwd: tempDir,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    })

    activeChild = proc

    try {
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])

      return { exitCode, stderr }
    } finally {
      activeChild = undefined
    }
  }

  const handlers = SIGNALS.map(([signal, code]) => {
    const handler = () => {
      try {
        activeChild?.kill(signal)
      } catch {}

      cleanup()
      process.exit(128 + code)
    }

    process.on(signal, handler)

    return [signal, handler] as const
  })

  try {
    const probeBin = path.join(tempDir, "vibest-probe")
    const probeExit = await runBun(compileArgs(probeBin, ["--bytecode", "--format=esm"]))

    if (probeExit !== 0) return probeExit

    const baseEnv = isolatedEnv(pgoHome)

    for (const step of PGO_STEPS) {
      const orderFile = path.join(tempDir, `order-${step.name}.txt`)

      const result = await runProbe(probeBin, step.args, {
        ...baseEnv,
        BUN_BYTECODE_ORDER_OUT: orderFile,
      })

      if (result.exitCode !== 0) {
        process.stderr.write(`PGO probe \`vibest ${step.args.join(" ")}\` exited ${result.exitCode}:\n${result.stderr}`)

        return result.exitCode
      }
    }

    stopTempDaemon(pgoHome)

    const orderArgs = PGO_PRIORITY.flatMap((name) => {
      const orderFile = path.join(tempDir, `order-${name}.txt`)

      return fs.existsSync(orderFile) && fs.statSync(orderFile).size > 0 ? [`--bytecode-order=${orderFile}`] : []
    })

    return await runBun(
      compileArgs(outfile, [
        "--bytecode",
        "--format=esm",
        ...orderArgs,
        "--compile-jit-policy=100",
        "--compile-exec-argv=--smol",
        ...(target ? ["--target", target] : []),
      ]),
    )
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler)
    cleanup()
  }
}

const exitCode = noBytecode
  ? await Bun.spawn([process.execPath, ...compileArgs(outfile, target ? ["--target", target] : [])], {
      cwd: cliDir,
      stdio: ["inherit", "inherit", "inherit"],
    }).exited
  : await buildWithPgo()

process.exit(exitCode)
