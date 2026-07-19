import type { WithEffectContext } from "@orpc/experimental-effect";
import type { FileSystem } from "effect/FileSystem";

import type { EventBus } from "../events";
import type { FileSystemService } from "../fs";
import type { HarnessAgentSessionService } from "../harness";
import type { ProjectService } from "../project";
import type { SessionRepository } from "../session";

/** Services every RPC procedure may `yield*`. */
export type RpcContext = WithEffectContext<
  | EventBus
  | FileSystem
  | HarnessAgentSessionService
  | ProjectService
  | FileSystemService
  | SessionRepository
>;
