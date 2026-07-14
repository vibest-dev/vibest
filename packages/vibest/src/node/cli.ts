#!/usr/bin/env node

import type { AddressInfo } from "node:net";

import { formatReadyLine } from "./handshake";
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
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port >= 0 ? port : DEFAULT_PORT;
}

async function main() {
  const authToken = takeAuthToken();
  const server = await createServer({ authToken, corsOrigins: readCorsOrigins() });

  server.listen(readPort(), "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    // Machine-readable first, for the desktop supervisor; human-readable second.
    console.log(formatReadyLine({ port }));
    console.log(`vibest listening on http://127.0.0.1:${port}`);
  });
}

main();
