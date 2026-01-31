import type { ContractRouterClient } from "@orpc/contract";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";

import type { Contract } from "../../../shared/contract";

export type Client = ContractRouterClient<Contract>;

/**
 * Create the oRPC client with MessagePort connection to main process.
 */
const { port1, port2 } = new MessageChannel();

// Send port2 to main process via preload
window.postMessage("orpc:connect", "*", [port2]);

// IMPORTANT: Start port1 to receive messages
// MessagePort requires explicit start() when using addEventListener()
// oRPC's RPCLink uses addEventListener internally but doesn't call start()
port1.start();

// Create the link and client
const link = new RPCLink({ port: port1 });

export const client: Client = createORPCClient(link);
