/**
 * The server's startup handshake. It binds to an OS-assigned port when asked
 * to, so it must tell its parent which port it actually got. One prefixed JSON
 * line on stdout, so a supervisor can pick it out of ordinary logging.
 */
export const READY_PREFIX = "vibest:ready ";

export type ReadyInfo = {
  port: number;
};

export function formatReadyLine(info: ReadyInfo): string {
  return `${READY_PREFIX}${JSON.stringify(info)}`;
}

export function parseReadyLine(line: string): ReadyInfo | null {
  if (!line.startsWith(READY_PREFIX)) return null;

  try {
    const parsed: unknown = JSON.parse(line.slice(READY_PREFIX.length));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { port } = parsed as { port?: unknown };
    if (typeof port !== "number" || !Number.isInteger(port)) return null;
    return { port };
  } catch {
    return null;
  }
}
