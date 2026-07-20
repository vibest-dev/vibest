import net from "node:net";
import type { AddressInfo } from "node:net";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { reservePort } from "../../src/daemon/port";

function occupy(): Promise<{ port: number; release: () => void }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, release: () => server.close() });
    });
  });
}

describe("reservePort", () => {
  it("returns an OS-assigned port when asked for an ephemeral one", async () => {
    const port = await Effect.runPromise(reservePort(0));
    expect(port).toBeGreaterThan(0);
  });

  it("falls back to an ephemeral port when the preferred one is taken", async () => {
    const held = await occupy();
    try {
      const port = await Effect.runPromise(reservePort(held.port));
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(held.port);
    } finally {
      held.release();
    }
  });
});
