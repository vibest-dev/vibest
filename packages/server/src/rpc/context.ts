import type { WithEffectContext } from "@orpc/experimental-effect";
import type { FileSystem } from "effect/FileSystem";

import type { EventBus } from "../events";
import type { FileSystemService } from "../fs";
import type { ProjectService } from "../project";
import type { SessionService } from "../session";

/** Services every RPC procedure may `yield*`. */
export type RpcContext = WithEffectContext<
  EventBus | FileSystem | SessionService | ProjectService | FileSystemService
>;
