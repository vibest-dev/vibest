import type { WithEffectContext } from "@orpc/experimental-effect";
import type { FileSystem } from "effect/FileSystem";

import type { EventBus } from "../events";
import type { FileSystemService } from "../fs";
import type {
  HarnessAgentRegistry,
  HarnessAgentSessionService,
  HarnessListService,
  HarnessProbeService,
} from "../harness";
import type { ProjectService } from "../project";

/** Services every RPC procedure may `yield*`. */
export type RpcContext = WithEffectContext<
  | EventBus
  | FileSystem
  | HarnessAgentRegistry
  | HarnessAgentSessionService
  | HarnessListService
  | HarnessProbeService
  | ProjectService
  | FileSystemService
>;
