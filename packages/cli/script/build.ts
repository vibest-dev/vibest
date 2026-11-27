import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { BunPlugin } from "bun"

import pkg from "../package.json" with { type: "json" }
import { packDirectoryArchive } from "../src/assets-archive.ts"
import { PLATFORM_TARGETS } from "../src/platform-target.ts"

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

const EXEC_ARGV = ["--smol", "--use-system-ca", "--no-warnings", "--"]

export const prepareAssetsArchive = (harnessesDir?: string) => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-assets-"))

  try {
    const targetHarnessesDir = harnessesDir ?? path.join(stageDir, "harnesses")

    const buildHarnesses = Bun.spawnSync(
      [process.execPath, path.join(cliDir, "script/build-harnesses.ts"), targetHarnessesDir],
      {
        cwd: cliDir,
        stdio: ["inherit", "inherit", "inherit"],
      },
    )

    if (buildHarnesses.exitCode !== 0) {
      fs.rmSync(stageDir, { recursive: true, force: true })
      process.exit(buildHarnesses.exitCode)
    }

    const archive = packDirectoryArchive([
      { prefix: "harnesses", dir: targetHarnessesDir },
      { prefix: "herdr-plugin", dir: path.join(cliDir, "herdr-plugin") },
    ])

    const archivePath = path.join(stageDir, "vibest-assets.bin")
    fs.writeFileSync(archivePath, archive)

    return { archivePath, cleanup: () => fs.rmSync(stageDir, { recursive: true, force: true }) }
  } catch (error) {
    fs.rmSync(stageDir, { recursive: true, force: true })
    throw error
  }
}

const embeddedAssetsPlugin = (archivePath: string): BunPlugin => ({
  name: "vibest-embedded-assets",
  setup(build) {
    build.onLoad({ filter: /packages[/\\]cli[/\\]src[/\\]embedded-assets\.ts$/ }, () => ({
      loader: "js",
      contents: [
        'import { readFileSync } from "node:fs"',
        'import { materializeAssets } from "./assets-archive.ts"',
        'import { VERSION } from "./version.ts"',
        `import archive from ${JSON.stringify(archivePath.replaceAll("\\", "/"))} with { type: "file" }`,
        "export const loadEmbeddedAssets = () => readFileSync(archive)",
        "export const materializeEmbedded = (home) => materializeAssets(home, VERSION, loadEmbeddedAssets())",
      ].join("\n"),
    }))
  },
})

export interface BuildJob {
  readonly outfile: string
  readonly target?: Bun.Build.CompileTarget | undefined
}

interface CompileOptions {
  readonly out: string
  readonly archivePath: string
  readonly bytecode: boolean
  readonly bytecodeOrder?: ReadonlyArray<string> | undefined
  readonly jitPolicy?: number | undefined
  readonly target?: Bun.Build.CompileTarget | undefined
}

type CompileObject = Exclude<NonNullable<Bun.BuildConfig["compile"]>, boolean | Bun.Build.CompileTarget>

type ExtendedCompileOptions = CompileObject & {
  bytecodeOrder?: Array<string>
  jitPolicy?: number
}

const compileBinary = async (options: CompileOptions): Promise<number> => {
  fs.mkdirSync(path.dirname(options.out), { recursive: true })

  const compile: ExtendedCompileOptions = {
    outfile: options.out,
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
    execArgv: EXEC_ARGV,
  }

  if (options.target) compile.target = options.target

  if (options.bytecodeOrder && options.bytecodeOrder.length > 0) compile.bytecodeOrder = [...options.bytecodeOrder]

  if (options.jitPolicy !== undefined) compile.jitPolicy = options.jitPolicy

  const result = await Bun.build({
    entrypoints: [path.join(cliDir, "src/main.ts")],
    tsconfig: path.join(cliDir, "tsconfig.json"),
    plugins: [embeddedAssetsPlugin(options.archivePath)],
    format: "esm",
    bytecode: options.bytecode,
    define: {
      VIBEST_VERSION: JSON.stringify(pkg.version),
    },
    compile,
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)

    return 1
  }

  return 0
}

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

export const buildBinaries = async (
  jobs: ReadonlyArray<BuildJob>,
  options: { readonly noBytecode?: boolean; readonly harnessesDir?: string } = {},
): Promise<number> => {
  const prepared = prepareAssetsArchive(options.harnessesDir)
  const { archivePath } = prepared

  try {
    if (options.noBytecode) {
      for (const job of jobs) {
        const code = await compileBinary({
          out: path.resolve(cliDir, job.outfile),
          archivePath,
          bytecode: false,
          target: job.target,
        })

        if (code !== 0) return code
      }

      return 0
    }

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
        prepared.cleanup()
        process.exit(128 + code)
      }

      process.on(signal, handler)

      return [signal, handler] as const
    })

    try {
      const probeBin = path.join(tempDir, "vibest-probe")

      const probeExit = await compileBinary({
        out: probeBin,
        archivePath,
        bytecode: true,
      })

      if (probeExit !== 0) return probeExit

      const baseEnv = isolatedEnv(pgoHome)

      for (const step of PGO_STEPS) {
        const orderFile = path.join(tempDir, `order-${step.name}.txt`)

        const result = await runProbe(probeBin, step.args, {
          ...baseEnv,
          BUN_BYTECODE_ORDER_OUT: orderFile,
        })

        if (result.exitCode !== 0) {
          process.stderr.write(
            `PGO probe \`vibest ${step.args.join(" ")}\` exited ${result.exitCode}:\n${result.stderr}`,
          )

          return result.exitCode
        }
      }

      stopTempDaemon(pgoHome)

      const orderFiles = PGO_PRIORITY.flatMap((name) => {
        const orderFile = path.join(tempDir, `order-${name}.txt`)

        return fs.existsSync(orderFile) && fs.statSync(orderFile).size > 0 ? [orderFile] : []
      })

      for (const job of jobs) {
        const code = await compileBinary({
          out: path.resolve(cliDir, job.outfile),
          archivePath,
          bytecode: true,
          bytecodeOrder: orderFiles,
          jitPolicy: 100,
          target: job.target,
        })

        if (code !== 0) return code
      }

      return 0
    } finally {
      for (const [signal, handler] of handlers) process.off(signal, handler)
      cleanup()
    }
  } finally {
    prepared.cleanup()
  }
}

if (import.meta.main) {
  const rawArgs = process.argv.slice(2)
  const noBytecode = rawArgs.includes("--no-bytecode")
  const positional = rawArgs.filter((arg) => arg !== "--no-bytecode")
  const [outfile = "dist/vibest", targetArg] = positional
  const matched = targetArg ? PLATFORM_TARGETS.find((t) => t.bunTarget === targetArg) : undefined

  if (targetArg && !matched) {
    console.error(`build: unknown bun target ${targetArg}`)
    process.exit(1)
  }

  const exitCode = await buildBinaries([{ outfile, target: matched?.bunTarget }], {
    noBytecode,
    harnessesDir: path.join(cliDir, "harnesses"),
  })

  process.exit(exitCode)
}
