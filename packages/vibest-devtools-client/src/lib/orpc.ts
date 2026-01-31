import type { RouterClient } from "@orpc/server";
import type { Router } from "@vibest/server-rpc/routes";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

const rpcUrl = new URL("/__vibest/rpc", window.location.origin).toString();

const link = new RPCLink({ url: rpcUrl });
export const orpc: RouterClient<Router> = createORPCClient(link);
