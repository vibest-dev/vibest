import type { WithEffectContext } from "@orpc/experimental-effect";
import type { HarnessAgentSessionService } from "@vibest/harness/runtime";
import type { FileSystem } from "effect/FileSystem";

import type { EventBus } from "../events";
import type { FileSystemService } from "../fs";
import type { ProjectService } from "../project";

/** Services every RPC procedure may `yield*`. */
export type RpcContext = WithEffectContext<
  EventBus | FileSystem | HarnessAgentSessionService | ProjectService | FileSystemService
>;
