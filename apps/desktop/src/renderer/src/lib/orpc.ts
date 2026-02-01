import { createTanstackQueryUtils } from "@orpc/tanstack-query";

import { client } from "./client";

// Create oRPC TanStack Query utils - single source of truth
export const orpc = createTanstackQueryUtils(client);
