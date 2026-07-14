import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";

import { DESKTOP_RPC_PREFIX, type DesktopContract } from "../shared/desktop-rpc";

export const DESKTOP_RPC_ORIGIN = "vibest://app";
export type DesktopClient = RouterContractClient<DesktopContract>;

export function createDesktopClient(): DesktopClient {
  const link = new RPCLink({
    origin: DESKTOP_RPC_ORIGIN,
    url: DESKTOP_RPC_PREFIX,
  });
  return createORPCClient(link);
}
