import { describe, expect, it } from "vitest";

import type { ServerConnection } from "@/server-connection";

import { createAppClients } from "./orpc";

describe("createAppClients", () => {
  it("creates clients for a resolved external server", () => {
    const server: ServerConnection = {
      httpBaseUrl: "http://127.0.0.1:43123",
      wsBaseUrl: "ws://127.0.0.1:43123",
      token: "desktop-token",
    };

    const clients = createAppClients(server);

    expect(clients.orpcClient).toBeDefined();
    expect(clients.orpcClient.session).toBeDefined();
    expect(clients.orpcClient.pty).toBeDefined();
    expect(clients.orpcQueryUtils).toBeDefined();
    clients.queryClient.clear();
  });
});
