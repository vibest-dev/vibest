import net from "node:net";

import { Effect } from "effect";

import { DaemonLaunchError } from "./errors";

/**
 * Reserve a loopback port for the daemon. Prefer `preferred` (default `:4000`)
 * so the daemon lands on a predictable address; if it is taken, fall back to an
 * OS-assigned ephemeral port. The launcher passes the result to the server and
 * records it, so callers never guess the port — they read it from `daemon.pid`.
 *
 * There is an inherent TOCTOU gap between closing this probe socket and the
 * daemon binding: acceptable for a single-user loopback daemon (a lost race
 * makes the daemon fail to bind, the health poll times out, and the launcher
 * reports it) and matched by how the SSH launch script picks a port.
 */
export const reservePort = (preferred: number): Effect.Effect<number, DaemonLaunchError> =>
  Effect.tryPromise({
    try: () => tryListen(preferred).catch(() => tryListen(0)),
    catch: (cause) =>
      new DaemonLaunchError({
        message: `Unable to reserve a port for the vibest daemon: ${String(cause)}`,
        cause,
      }),
  });

function tryListen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => {
      const address = probe.address();
      const resolved = typeof address === "object" && address ? address.port : port;
      probe.close(() => resolve(resolved));
    });
  });
}
