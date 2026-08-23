import { createORPCClient } from "@orpc/client";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type { RouterContractClient } from "@orpc/contract";
import type { Contract } from "@vibest/contract";

/** A fully typed client for the Vibest server, derived from the contract. */
export type VibestClient = RouterContractClient<Contract>;

export type CreateVibestClientOptions = {
  /** WebSocket endpoint. Defaults to `/ws/rpc` on the current origin. */
  url?: string | URL;
  /** WebSocket subprotocol; the CLI server upgrades on "vibest". */
  protocols?: string | string[];
  /**
   * Mint a single-use ticket for the handshake. A browser cannot set headers on
   * a WebSocket upgrade, so the bearer token can't travel with it; the desktop
   * renderer fetches a ticket over the authenticated HTTP link instead. The
   * link re-invokes `connect` on every reconnect, so each attempt gets a fresh
   * ticket. Omitted in browser mode, where the server requires none.
   */
  getTicket?: () => Promise<string>;
};

function defaultWsUrl(): URL {
  const url = new URL("/ws/rpc", globalThis.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

/**
 * The link's `connect` factory. Exported so the ticket handshake is testable
 * without standing up a socket server.
 */
export function createWsConnect(options: CreateVibestClientOptions): () => Promise<WebSocket> {
  return async () => {
    const url = new URL(options.url ?? defaultWsUrl());
    if (options.getTicket) {
      url.searchParams.set("ticket", await options.getTicket());
    }
    return new WebSocket(url, options.protocols ?? "vibest");
  };
}

/**
 * WebSocket client: every call multiplexed over one connection. The link takes
 * a lazy `connect` factory (oRPC 2.0.0-beta.16), so the socket is only opened
 * on first use — and re-opened, with a fresh ticket, on every reconnect.
 */
export function createVibestClient(options: CreateVibestClientOptions = {}): VibestClient {
  const link = new WebSocketRPCLink({
    connect: createWsConnect(options),
    // Reconnect is opt-in in oRPC and OFF by default. Without it the link
    // holds the dead socket after a drop and every later call hangs on a
    // send into it — one network blip kills the client until a full page
    // reload. Enabled, the next call after a drop re-invokes `connect` (and
    // so mints a fresh ticket); in-flight calls still reject on the drop,
    // which consumers (e.g. the chat transport's retry loop) recover from.
    reconnect: { enabled: true },
  });
  return createORPCClient(link);
}
