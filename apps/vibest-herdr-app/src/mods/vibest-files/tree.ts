import { exec } from "herdr"

export interface Entry {
  readonly name: string
  readonly dir: boolean
}

export const PER_FOLDER = 500
export const TOTAL = 5000

const LIST =
  'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"'

export const directory = async (path: string, on: string | null): Promise<Entry[]> => {
  const r = await exec("sh", ["-c", LIST, "files", path], { on })
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder")
  const fields = r.stdout.split("\0")
  const out: Entry[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" })
  return out
}

export const gitMarks = async (cwd: string, on: string | null): Promise<Record<string, string>> => {
  const marks: Record<string, string> = {}
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch((): null => null)
  if (top?.code !== 0) return marks
  const status = await exec(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--untracked-files=all",
    ],
    { cwd, on },
  ).catch((): null => null)
  if (status?.code !== 0) return marks
  for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
    const xy = entry.slice(0, 2)
    marks[`${top.stdout.trim()}/${entry.slice(3)}`] =
      xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M"
  }
  return marks
}
