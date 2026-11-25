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

const spawnBun = (args: ReadonlyArray<string>) =>
  Bun.spawnSync(["bun", ...args], {
    cwd: cliDir,
    stdio: ["inherit", "inherit", "inherit"],
  }).exitCode

const isolatedEnv = (pgoHome: string) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("VIBEST_") && key !== "BUN_BYTECODE_ORDER_OUT",
    ),
  ),
  VIBEST_HOME: pgoHome,
})

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
}

const buildWithPgo = (): number => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpgo-"))
  const pgoHome = path.join(tempDir, "h")
  fs.mkdirSync(pgoHome, { recursive: true })

  try {
    const probeBin = path.join(tempDir, "vibest-probe")
    const probeExit = spawnBun(compileArgs(probeBin, ["--bytecode", "--format=esm"]))

    if (probeExit !== 0) return probeExit

    const baseEnv = isolatedEnv(pgoHome)

    for (const step of PGO_STEPS) {
      const orderFile = path.join(tempDir, `order-${step.name}.txt`)
      Bun.spawnSync([probeBin, ...step.args], {
        cwd: tempDir,
        env: { ...baseEnv, BUN_BYTECODE_ORDER_OUT: orderFile },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
    }

    stopTempDaemon(pgoHome)

    const orderArgs: Array<string> = []

    for (const name of PGO_PRIORITY) {
      const orderFile = path.join(tempDir, `order-${name}.txt`)

      if (fs.existsSync(orderFile) && fs.statSync(orderFile).size > 0) orderArgs.push(`--bytecode-order=${orderFile}`)
    }

    return spawnBun(
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
    stopTempDaemon(pgoHome)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

const exitCode = noBytecode ? spawnBun(compileArgs(outfile, target ? ["--target", target] : [])) : buildWithPgo()

process.exit(exitCode)
