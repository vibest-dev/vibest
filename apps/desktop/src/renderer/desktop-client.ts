import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterContractClient } from "@orpc/contract";

import type { DesktopContract } from "../shared/desktop-rpc";

export type DesktopClient = RouterContractClient<DesktopContract>;

export function createDesktopClient(port: MessagePort): DesktopClient {
  return createORPCClient(new RPCLink({ port }));
}
