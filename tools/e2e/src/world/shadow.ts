import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type Profile = "user" | "first-run"

export const FAKE_ANTHROPIC_KEY = "sk-ant-e2e-fake-0123456789abcdefghijklmnop"

const home = os.homedir()
const user = {
  claudeSettings: path.join(home, ".claude", "settings.json"),
  claudeState: path.join(home, ".claude.json"),
  piSettings: path.join(home, ".pi", "agent", "settings.json"),
  piTrust: path.join(home, ".pi", "agent", "trust.json"),
  cursorConfig: path.join(home, ".cursor", "cli-config.json"),
  cursorHooks: path.join(home, ".cursor", "hooks.json"),
}

const CLAUDE_SETTINGS = ["permissions", "env", "language", "worktree", "autoMode", "attribution", "cleanupPeriodDays"]
const CLAUDE_STATE = [
  "hasCompletedOnboarding",
  "lastOnboardingVersion",
  "hasSeenAutoModeEntryWarning",
  "hasResetAutoModeOptInForDefaultOffer",
  "hasSeenAutoModeOutsideReadPrompt",
  "autoModeEnvSetup",
]
const PI_SETTINGS = [
  "defaultThinkingLevel",
  "defaultTools",
  "steeringMode",
  "doubleEscapeAction",
  "codemode",
  "tuiMode",
  "theme",
]
const CURSOR_BEHAVIOUR = ["approvalMode", "sandbox", "permissions", "network"]

export const userFilesRead: ReadonlyArray<{ readonly file: string; readonly keys?: ReadonlyArray<string> }> = [
  { file: user.claudeSettings, keys: CLAUDE_SETTINGS },
  { file: user.claudeState, keys: CLAUDE_STATE },
  { file: user.piSettings, keys: PI_SETTINGS },
  { file: user.piTrust },
  { file: user.cursorConfig, keys: CURSOR_BEHAVIOUR },
  { file: user.cursorHooks },
]

const readJson = async (file: string): Promise<Record<string, unknown>> => {
  const text = await fs.readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return {}
  const parsed = JSON.parse(text) as unknown
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

const pick = (from: Record<string, unknown>, keys: ReadonlyArray<string>) =>
  Object.fromEntries(keys.filter((k) => k in from).map((k) => [k, from[k]]))

const writeJson = (file: string, value: unknown) =>
  fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })

const localNeverProxied = (env: Record<string, unknown>) => {
  for (const name of ["NO_PROXY", "no_proxy"])
    if (name in env || "HTTPS_PROXY" in env || "HTTP_PROXY" in env || "https_proxy" in env || "http_proxy" in env)
      env[name] = [...new Set([...String(env[name] ?? "").split(","), "127.0.0.1", "localhost"].filter(Boolean))].join(
        ",",
      )
  return env
}

const fakeModelCannotAnswerAutoModeClassifier = {
  disableAutoMode: "disable",
  permissions: { defaultMode: "default", disableAutoMode: "disable" },
}

export const claudeShadow = async (dir: string, profile: Profile) => {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const keyApproved = { customApiKeyResponses: { approved: [FAKE_ANTHROPIC_KEY.slice(-20)], rejected: [] } }
  if (profile === "first-run") {
    await writeJson(path.join(dir, ".claude.json"), { hasCompletedOnboarding: true, ...keyApproved })
    await writeJson(path.join(dir, "settings.json"), fakeModelCannotAnswerAutoModeClassifier)
    return dir
  }
  const settings = pick(await readJson(user.claudeSettings), CLAUDE_SETTINGS)
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>
  await writeJson(path.join(dir, "settings.json"), {
    ...settings,
    env: localNeverProxied({ ...((settings.env ?? {}) as Record<string, unknown>) }),
    disableAutoMode: fakeModelCannotAnswerAutoModeClassifier.disableAutoMode,
    permissions: { ...permissions, ...fakeModelCannotAnswerAutoModeClassifier.permissions },
  })
  await writeJson(path.join(dir, ".claude.json"), {
    hasCompletedOnboarding: true,
    ...pick(await readJson(user.claudeState), CLAUDE_STATE),
    ...keyApproved,
  })
  return dir
}

export type PiProvider = { readonly baseUrl: string; readonly models?: ReadonlyArray<string> }

export const piShadow = async (
  dir: string,
  profile: Profile,
  providers: Record<string, PiProvider>,
  defaults: { readonly provider: string; readonly model: string } | undefined = { provider: "fake", model: "m" },
) => {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const settings = profile === "user" ? pick(await readJson(user.piSettings), PI_SETTINGS) : {}
  await writeJson(path.join(dir, "settings.json"), {
    ...settings,
    ...(defaults ? { defaultProvider: defaults.provider, defaultModel: defaults.model } : {}),
  })
  if (Object.keys(providers).length > 0)
    await writeJson(path.join(dir, "models.json"), {
      providers: Object.fromEntries(
        Object.entries(providers).map(([name, p]) => [
          name,
          {
            baseUrl: p.baseUrl,
            apiKey: "fake",
            api: "openai-completions",
            models: (p.models ?? ["m"]).map((id) => ({ id, contextWindow: 100_000, maxTokens: 1000 })),
          },
        ]),
      ),
    })
  if (profile === "user") await fs.copyFile(user.piTrust, path.join(dir, "trust.json")).catch(() => undefined)
  return dir
}

export const cursorShadow = async (dir: string, profile: Profile, vibest: string) => {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const own = profile === "user" ? await readJson(user.cursorConfig) : {}
  await writeJson(
    path.join(dir, "cli-config.json"),
    Object.keys(own).length > 0
      ? own
      : { version: 1, permissions: { allow: [`Shell(${vibest} report)`, "Shell(vibest report)"], deny: [] } },
  )
  return dir
}
