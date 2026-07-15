#!/usr/bin/env node

import { formatReadyLine } from "./handshake";
import { listenServer } from "./listen";
import { createServer } from "./server";

const DEFAULT_PORT = 4000;

/**
 * Read the token, then scrub it. The agent spawns a shell for every tool call
 * and children inherit this environment — an agent-run command must not be
 * able to read the credential that guards the agent.
 */
function takeAuthToken(): string | undefined {
  const token = process.env.VIBEST_AUTH_TOKEN;
  delete process.env.VIBEST_AUTH_TOKEN;
  return token;
}

function readCorsOrigins(): string[] {
  return (process.env.VIBEST_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function readPort(): number {
  const raw = process.env.VIBEST_PORT;
  if (raw === undefined) return process.env.NODE_ENV === "development" ? 0 : DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port >= 0 ? port : DEFAULT_PORT;
}

async function main() {
  const authToken = takeAuthToken();
  const server = await createServer({ authToken, corsOrigins: readCorsOrigins() });
  let port: number;
  try {
    port = await listenServer(server, readPort());
  } catch (error) {
    await server.dispose();
    throw error;
  }

  // Machine-readable first, for the desktop supervisor; human-readable second.
  console.log(formatReadyLine({ port }));
  console.log(`vibest listening on http://127.0.0.1:${port}`);

  let shuttingDown: Promise<void> | undefined;
  const shutdown = () =>
    (shuttingDown ??= server.dispose().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    }));
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
