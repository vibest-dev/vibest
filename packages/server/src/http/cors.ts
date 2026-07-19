/**
 * Cross-origin headers for an allowlisted origin, or null to deny.
 *
 * The desktop renderer loads from `vibest://app` (or the Vite dev server in
 * dev) and calls the backend on `http://127.0.0.1:<port>` — a cross-origin
 * request. Browser mode is same-origin and sends no Origin header, so it never
 * reaches this path.
 */
export function corsHeaders(
  origin: string | undefined,
  allowed: readonly string[],
): Record<string, string> | null {
  if (!origin || !allowed.includes(origin)) return null;

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}
