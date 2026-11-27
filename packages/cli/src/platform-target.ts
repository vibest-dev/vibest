import childProcess from "node:child_process"
import fs from "node:fs"

export type BunCompileTarget =
  | "bun-darwin-arm64"
  | "bun-darwin-x64"
  | "bun-linux-arm64"
  | "bun-linux-arm64-musl"
  | "bun-linux-x64"
  | "bun-linux-x64-musl"

export interface PlatformTarget {
  readonly id: string
  readonly bunTarget: BunCompileTarget
  readonly os: "darwin" | "linux"
  readonly cpu: "arm64" | "x64"
  readonly libc?: "glibc" | "musl"
}

export const PLATFORM_TARGETS: ReadonlyArray<PlatformTarget> = [
  { id: "darwin-arm64", bunTarget: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { id: "darwin-x64", bunTarget: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  { id: "linux-arm64", bunTarget: "bun-linux-arm64", os: "linux", cpu: "arm64", libc: "glibc" },
  { id: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl" },
  { id: "linux-x64", bunTarget: "bun-linux-x64", os: "linux", cpu: "x64", libc: "glibc" },
  { id: "linux-x64-musl", bunTarget: "bun-linux-x64-musl", os: "linux", cpu: "x64", libc: "musl" },
]

export const findTarget = (id: string): PlatformTarget | undefined => PLATFORM_TARGETS.find((t) => t.id === id)

const runText = (cmd: string, args: ReadonlyArray<string>): string => {
  try {
    const out = childProcess.spawnSync(cmd, [...args], { encoding: "utf8" })

    return `${out.stdout ?? ""}${out.stderr ?? ""}`.trim()
  } catch {
    return ""
  }
}

export const detectPlatformTarget = (): string => {
  const os = process.platform === "darwin" ? "darwin" : "linux"
  const rawArch = process.arch === "arm64" ? "arm64" : "x64"

  const arch =
    os === "darwin" && rawArch === "x64" && runText("sysctl", ["-n", "sysctl.proc_translated"]) === "1"
      ? "arm64"
      : rawArch

  const musl = os === "linux" && (fs.existsSync("/etc/alpine-release") || /musl/i.test(runText("ldd", ["--version"])))

  return `${os}-${arch}${musl ? "-musl" : ""}`
}
