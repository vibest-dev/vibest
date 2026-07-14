import { describe, expect, it, vi } from "vitest";

import { createWsConnect } from "./index";

describe("createWsConnect", () => {
  it("does not fetch a ticket until a connection is attempted", () => {
    const getTicket = vi.fn<() => Promise<string>>(async () => "ticket-1");

    createWsConnect({ url: "ws://127.0.0.1:4100/ws/rpc", getTicket });

    expect(getTicket).not.toHaveBeenCalled();
  });

  it("appends the fetched ticket to the socket URL", async () => {
    const opened: string[] = [];
    function FakeSocket(url: string | URL) {
      opened.push(url.toString());
    }
    vi.stubGlobal("WebSocket", FakeSocket);

    const connect = createWsConnect({
      url: "ws://127.0.0.1:4100/ws/rpc",
      getTicket: async () => "ticket-1",
    });
    await connect();

    expect(opened).toEqual(["ws://127.0.0.1:4100/ws/rpc?ticket=ticket-1"]);
    vi.unstubAllGlobals();
  });

  it("mints a fresh ticket on every reconnect, since a ticket is single-use", async () => {
    const opened: string[] = [];
    function FakeSocket(url: string | URL) {
      opened.push(url.toString());
    }
    vi.stubGlobal("WebSocket", FakeSocket);

    let issued = 0;
    const connect = createWsConnect({
      url: "ws://127.0.0.1:4100/ws/rpc",
      getTicket: async () => {
        issued += 1;
        return `ticket-${issued}`;
      },
    });
    await connect();
    await connect();

    expect(opened).toEqual([
      "ws://127.0.0.1:4100/ws/rpc?ticket=ticket-1",
      "ws://127.0.0.1:4100/ws/rpc?ticket=ticket-2",
    ]);
    vi.unstubAllGlobals();
  });

  it("opens the bare URL when no ticket is required (browser mode)", async () => {
    const opened: string[] = [];
    function FakeSocket(url: string | URL) {
      opened.push(url.toString());
    }
    vi.stubGlobal("WebSocket", FakeSocket);

    const connect = createWsConnect({ url: "ws://127.0.0.1:4100/ws/rpc" });
    await connect();

    expect(opened).toEqual(["ws://127.0.0.1:4100/ws/rpc"]);
    vi.unstubAllGlobals();
  });
});
