import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type { RouterContractClient } from "@orpc/contract";
import type { Contract } from "@vibest/contract";

/** A fully typed client for the Vibest server, derived from the contract. */
export type VibestClient = RouterContractClient<Contract>;

type FetchLinkUrl = NonNullable<ConstructorParameters<typeof RPCLink>[0]>["url"];

type FetchLinkOrigin = NonNullable<ConstructorParameters<typeof RPCLink>[0]>["origin"];

export type CreateVibestClientOptions = {
  /**
   * RPC path. Defaults to `/api/rpc` — clients served same-origin by the CLI
   * server need no configuration. oRPC types this as a root-relative path, so
   * a cross-origin caller sets `origin` alongside it, not an absolute `url`.
   */
  url?: FetchLinkUrl;
  /**
   * Absolute origin prepended to `url`, e.g. `http://127.0.0.1:41234`. The
   * desktop renderer loads from a custom protocol, so it must point every call
   * at the backend it spawned; browser mode is same-origin and omits this.
   */
  origin?: FetchLinkOrigin;
  /**
   * Headers sent with every call. The desktop renderer passes the per-launch
   * bearer token here; browser mode is same-origin and needs none.
   */
  headers?: Record<string, string>;
};

/** HTTP client (fetch link). One request per call; streams over SSE. */
export function createVibestClient(options: CreateVibestClientOptions = {}): VibestClient {
  const link = new RPCLink({
    url: options.url ?? "/api/rpc",
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  });
  return createORPCClient(link);
}

export type CreateVibestWsClientOptions = {
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
export function createWsConnect(options: CreateVibestWsClientOptions): () => Promise<WebSocket> {
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
export function createVibestWsClient(options: CreateVibestWsClientOptions = {}): VibestClient {
  const link = new WebSocketRPCLink({
    connect: createWsConnect(options),
  });
  return createORPCClient(link);
}
