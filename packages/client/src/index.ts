import type { RouterContractClient } from "@orpc/contract";
import type { Contract } from "@vibest/contract";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";

/** A fully typed client for the Vibest server, derived from the contract. */
export type VibestClient = RouterContractClient<Contract>;

type FetchLinkUrl = NonNullable<ConstructorParameters<typeof RPCLink>[0]>["url"];

export type CreateVibestClientOptions = {
  /**
   * RPC endpoint. Defaults to the relative `/api/rpc` — clients served
   * same-origin by the CLI server need no configuration.
   */
  url?: FetchLinkUrl;
};

/** HTTP client (fetch link). One request per call; streams over SSE. */
export function createVibestClient(options: CreateVibestClientOptions = {}): VibestClient {
  const link = new RPCLink({
    url: options.url ?? "/api/rpc",
  });
  return createORPCClient(link);
}

export type CreateVibestWsClientOptions = {
  /** WebSocket endpoint. Defaults to `/ws/rpc` on the current origin. */
  url?: string | URL;
  /** WebSocket subprotocol; the CLI server upgrades on "vibest". */
  protocols?: string | string[];
};

function defaultWsUrl(): URL {
  const url = new URL("/ws/rpc", globalThis.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

/**
 * WebSocket client: every call multiplexed over one connection. The link
 * takes a lazy `connect` factory (oRPC 2.0.0-beta.16), so the socket is only
 * opened on first use.
 */
export function createVibestWsClient(options: CreateVibestWsClientOptions = {}): VibestClient {
  const link = new WebSocketRPCLink({
    connect: () => new WebSocket(options.url ?? defaultWsUrl(), options.protocols ?? "vibest"),
  });
  return createORPCClient(link);
}
