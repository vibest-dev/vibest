import childProcess from "node:child_process"
import fs from "node:fs"

export const PLATFORM_TARGET_IDS = [
  "darwin-arm64",
  "darwin-x64",
  "darwin-x64-baseline",
  "linux-arm64",
  "linux-arm64-musl",
  "linux-x64",
  "linux-x64-baseline",
  "linux-x64-musl",
  "linux-x64-baseline-musl",
] as const

export const PRIMARY_TARGET_IDS = PLATFORM_TARGET_IDS.filter((id) => !id.includes("-baseline"))

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

  const hasAvx2 =
    arch !== "x64"
      ? true
      : os === "darwin"
        ? runText("sysctl", ["-n", "hw.optional.avx2_0"]) === "1"
        : (() => {
            try {
              return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
            } catch {
              return false
            }
          })()

  return `${os}-${arch}${hasAvx2 ? "" : "-baseline"}${musl ? "-musl" : ""}`
}
