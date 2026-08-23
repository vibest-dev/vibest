/**
 * Origin / host policy for the local daemon. Static by design: the desktop
 * renderer's fixed scheme and any loopback web client are always trusted, so a
 * CLI-started daemon accepts the desktop with no per-launch origin negotiation
 * (and no restart-to-widen-CORS dance). Extra origins — e.g. a future hosted
 * web app reaching into a local daemon — come from `VIBEST_CORS_ORIGINS`.
 */

/** The desktop renderer's custom-scheme origin (see desktop app-protocol.ts). */
const DESKTOP_ORIGIN = "vibest://app";

/** `http(s)://localhost | 127.0.0.1 | [::1]` on any port — the loopback web clients. */
const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/;

/** A Host header or allowlist entry reduced to a bare lowercase hostname. */
function hostnameOf(host: string): string {
  return host.replace(/:\d+$/, "").toLowerCase();
}

/**
 * The two configured trust extensions, named so call sites cannot swap them:
 * `extraOrigins` (`VIBEST_CORS_ORIGINS`) allowlists exact Origin values, while
 * `allowedHosts` (`VIBEST_ALLOWED_HOSTS`) trusts a reverse proxy's Host — and,
 * through {@link isAllowedOrigin}, the origins it serves.
 */
export type OriginPolicy = {
  readonly extraOrigins?: readonly string[];
  readonly allowedHosts?: readonly string[];
};

/**
 * Whether a browser Origin may talk to the daemon — used for both the CORS
 * response headers and the WebSocket-upgrade guard. A same-origin browser
 * request and a native client both send no Origin, which callers handle before
 * reaching here.
 *
 * `allowedHosts` extends trust to origins served *by* a trusted reverse proxy:
 * a page loaded from an allowlisted Host connects back with an Origin naming
 * that same hostname, so any origin whose hostname is allowlisted is accepted
 * regardless of scheme or port — otherwise `VIBEST_ALLOWED_HOSTS` would render
 * the page but leave its WebSocket unable to connect.
 */
export function isAllowedOrigin(origin: string, policy: OriginPolicy = {}): boolean {
  const { extraOrigins = [], allowedHosts = [] } = policy;
  if (origin === DESKTOP_ORIGIN || LOOPBACK_ORIGIN.test(origin) || extraOrigins.includes(origin)) {
    return true;
  }
  if (allowedHosts.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((allowed) => hostnameOf(allowed) === hostname);
}

/**
 * Whether a Host header names the loopback interface the daemon binds. The
 * server listens on `127.0.0.1` only, so a request arriving with any other Host
 * is a DNS-rebinding attempt (an attacker page whose domain now resolves to
 * loopback, which CORS does not stop) and must be refused. A request with no
 * Host is not a browser and is left to the auth layer.
 *
 * `extra` lists additional trusted hostnames — a reverse proxy the user runs
 * in front of the daemon (e.g. `tailscale serve` forwarding a tailnet MagicDNS
 * name) preserves its public Host, which is indistinguishable from a rebound
 * one without an explicit allowlist (`VIBEST_ALLOWED_HOSTS`).
 */
export function isLoopbackHost(host: string | undefined, extra: readonly string[] = []): boolean {
  if (host === undefined) return true;
  const hostname = hostnameOf(host);
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    // Entries are normalized the same way as the incoming Host, so a
    // configured `proxy.example.com:8443` matches requests on any port.
    extra.some((allowed) => hostnameOf(allowed) === hostname)
  );
}

/**
 * CORS headers for an allowlisted cross-origin request, or null to deny. A
 * same-origin browser request sends no Origin header and never reaches here.
 * The origin is echoed (never `*`) so credentials can be sent.
 */
export function corsHeaders(
  origin: string | undefined,
  policy: OriginPolicy = {},
): Record<string, string> | null {
  if (!origin || !isAllowedOrigin(origin, policy)) return null;

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}
