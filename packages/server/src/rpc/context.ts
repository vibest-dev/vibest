import type { WithEffectContext } from "@orpc/experimental-effect";

import type { EventBus } from "../events";
import type { ProjectService } from "../project";
import type { SessionService } from "../session";

/** Services every RPC procedure may `yield*`. */
export type RpcContext = WithEffectContext<EventBus | SessionService | ProjectService>;
