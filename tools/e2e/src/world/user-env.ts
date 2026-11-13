import childProcess from "node:child_process"
import os from "node:os"
import path from "node:path"

const shellSessionState = /^(_|PWD|OLDPWD|SHLVL|HISTFILE|FNM_MULTISHELL_PATH|__MISE_.*|_P9K_.*|P9K_.*)$/
const runnerOnly = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_.*|VIBEST_.*|HERDR_.*|HC_.*|PI_PACKAGE_DIR)$/
export const realModelAccess =
  /^(ANTHROPIC_.*|OPENAI_.*|GEMINI_.*|GOOGLE_.*|XAI_.*|OPENROUTER_.*|CURSOR_API_KEY|.*_API_KEY|CLAUDE_CODE_.*|AWS_.*|VERTEX_.*|CLOUD_ML_.*|.*_MODEL|.*_BASE_URL)$/
export const secretName = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|PROXY/i
export const keptForAModel = (name: string) =>
  !realModelAccess.test(name) && !(secretName.test(name) && !/PROXY/i.test(name))

export const capture = (home = os.homedir(), shell = process.env.SHELL || "/bin/zsh") => {
  const base = {
    HOME: home,
    USER: os.userInfo().username,
    LOGNAME: os.userInfo().username,
    SHELL: shell,
    TERM: "xterm-256color",
    LANG: process.env.LANG || "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HISTFILE: "/dev/null",
  }
  const r = childProcess.spawnSync(shell, ["-l", "-i", "-c", "unset HISTFILE; env -0"], {
    env: base,
    cwd: home,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  })
  if (r.status !== 0 || r.stdout.length === 0)
    throw new Error(`could not read the login environment of ${shell} (exit ${r.status ?? r.signal})`)
  const env: Record<string, string> = {}
  for (const pair of r.stdout.toString("utf8").split("\0")) {
    const at = pair.indexOf("=")
    if (at <= 0) continue
    const name = pair.slice(0, at)
    if (shellSessionState.test(name) || runnerOnly.test(name) || realModelAccess.test(name)) continue
    env[name] = pair.slice(at + 1)
  }
  for (const name of ["NO_PROXY", "no_proxy"])
    env[name] = [...new Set([...(env[name] ?? "").split(","), "127.0.0.1", "localhost"].filter(Boolean))].join(",")
  return env
}

export const historyFiles = (home = os.homedir()) => [
  path.join(home, ".zsh_history"),
  path.join(home, ".bash_history"),
  path.join(home, ".local", "share", "fish", "fish_history"),
]
