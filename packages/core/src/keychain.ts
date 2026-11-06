import { Context, Effect, Layer } from "effect"

export const CLAUDE_CREDENTIALS = "Claude Code-credentials"
export const CURSOR_ACCESS_TOKEN = "cursor-access-token"

export const securityArgs = (service: string) => ["security", "find-generic-password", "-s", service, "-w"] as const

export const claudeCredentialsFile = (home: string) => `${home}/.claude/.credentials.json`

export interface KeychainPlatform {
  readonly password: (service: string) => Effect.Effect<string | undefined>
}

export class Keychain extends Context.Service<Keychain, KeychainPlatform>()("vibest/Keychain") {
  static readonly layer = (platform: KeychainPlatform) => Layer.succeed(Keychain, Keychain.of(platform))
}
