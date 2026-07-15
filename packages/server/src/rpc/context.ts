import type { WithEffectContext } from "@orpc/experimental-effect";
import type { HarnessAgentSessionService } from "@vibest/harness/runtime";

import type { EventBus } from "../events";

/** Services every RPC procedure may `yield*`. */
export type RpcContext = WithEffectContext<EventBus | HarnessAgentSessionService>;
