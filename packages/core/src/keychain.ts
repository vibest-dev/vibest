// Reading a harness's own credential. The platform adapter does the read (macOS keychain, or the Linux file);
// this service is what the poller calls. The value is a secret: never log it.
import { Context, Effect, Layer } from "effect"

export const CLAUDE_CREDENTIALS = "Claude Code-credentials"
export const CURSOR_ACCESS_TOKEN = "cursor-access-token"

/** `security find-generic-password -s <service> -w` — the password on stdout, nothing else. */
export const securityArgs = (service: string) => ["security", "find-generic-password", "-s", service, "-w"] as const

/** Claude Code's Linux credential file (the keychain item's JSON, same shape). */
export const claudeCredentialsFile = (home: string) => `${home}/.claude/.credentials.json`

/** What the runtime can read. undefined: no store, or the item is missing, locked, or denied. */
export interface KeychainPlatform {
  readonly password: (service: string) => Effect.Effect<string | undefined>
}

export class Keychain extends Context.Service<Keychain, KeychainPlatform>()("vibest/Keychain") {
  static readonly layer = (platform: KeychainPlatform) => Layer.succeed(Keychain, Keychain.of(platform))
}
