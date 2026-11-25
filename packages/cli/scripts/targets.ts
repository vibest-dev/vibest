export interface PlatformTarget {
  readonly id: string
  readonly bunTarget: Bun.Build.CompileTarget
  readonly os: "darwin" | "linux"
  readonly cpu: "arm64" | "x64"
  readonly libc?: "glibc" | "musl"
  readonly baseline?: true
}

export const PLATFORM_TARGETS: ReadonlyArray<PlatformTarget> = [
  { id: "darwin-arm64", bunTarget: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { id: "darwin-x64", bunTarget: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  { id: "darwin-x64-baseline", bunTarget: "bun-darwin-x64-baseline", os: "darwin", cpu: "x64", baseline: true },
  { id: "linux-arm64", bunTarget: "bun-linux-arm64", os: "linux", cpu: "arm64", libc: "glibc" },
  { id: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl", os: "linux", cpu: "arm64", libc: "musl" },
  { id: "linux-x64", bunTarget: "bun-linux-x64", os: "linux", cpu: "x64", libc: "glibc" },
  {
    id: "linux-x64-baseline",
    bunTarget: "bun-linux-x64-baseline",
    os: "linux",
    cpu: "x64",
    libc: "glibc",
    baseline: true,
  },
  { id: "linux-x64-musl", bunTarget: "bun-linux-x64-musl", os: "linux", cpu: "x64", libc: "musl" },
  {
    id: "linux-x64-baseline-musl",
    bunTarget: "bun-linux-x64-baseline-musl",
    os: "linux",
    cpu: "x64",
    libc: "musl",
    baseline: true,
  },
]

export const PRIMARY_TARGETS = PLATFORM_TARGETS.filter((t) => !t.baseline)

export const findTarget = (id: string): PlatformTarget | undefined => PLATFORM_TARGETS.find((t) => t.id === id)
