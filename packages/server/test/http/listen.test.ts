import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { listenServer } from "../../src/http/listen";

const servers = new Set<ReturnType<typeof createServer>>();

const makeServer = () => {
  const server = createServer();
  servers.add(server);
  return server;
};

afterEach(async () => {
  await Promise.all(
    Array.from(servers, (server) =>
      server.listening
        ? new Promise<void>((resolve) => server.close(() => resolve()))
        : Promise.resolve(),
    ),
  );
  servers.clear();
});

describe("listenServer", () => {
  it("returns an OS-assigned port", async () => {
    const port = await listenServer(makeServer(), 0);
    expect(port).toBeGreaterThan(0);
  });

  it("rejects instead of emitting an unhandled error when a port is occupied", async () => {
    const blocker = makeServer();
    const occupiedPort = await listenServer(blocker, 0);

    await expect(listenServer(makeServer(), occupiedPort)).rejects.toMatchObject({
      code: "EADDRINUSE",
      port: occupiedPort,
    });
    expect((blocker.address() as AddressInfo).port).toBe(occupiedPort);
  });
});
