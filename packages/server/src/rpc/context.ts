import type { WithEffectContext } from "@orpc/experimental-effect";

import type { ClaudeCode } from "./claude-code";
import type { Codex } from "./codex";

/** Services every RPC procedure may `yield*`. */
export type RpcContext = WithEffectContext<ClaudeCode | Codex>;
