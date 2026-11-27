import { NoSuchSession } from "@vibest/schema/session"
import { Context } from "effect"
import { HttpApiMiddleware } from "effect/http-api"

import { DaemonStopping, Forbidden, InvalidCaller, InvalidRequestError, ProtocolRejected } from "./errors.ts"

export type CallerIdentity =
  | { readonly _tag: "Cli"; readonly repositoryRoot: string }
  | { readonly _tag: "Ui" }
  | {
      readonly _tag: "Session"
      readonly sessionId: string
      readonly projectId: string
      readonly repositoryRoot?: string
    }
  | {
      readonly _tag: "Remote"
      readonly remoteId: string
      readonly projectId?: string
      readonly session?: string
    }

export class Caller extends Context.Service<Caller, CallerIdentity>()("vibest/Caller") {}

export class ProtocolMiddleware extends HttpApiMiddleware.Service<ProtocolMiddleware>()("vibest/ProtocolMiddleware", {
  error: [ProtocolRejected],
}) {}

export class CallerMiddleware extends HttpApiMiddleware.Service<CallerMiddleware, { provides: Caller }>()(
  "vibest/CallerMiddleware",
  {
    error: [InvalidCaller, Forbidden, NoSuchSession],
  },
) {}

export class AdmissionMiddleware extends HttpApiMiddleware.Service<AdmissionMiddleware>()(
  "vibest/AdmissionMiddleware",
  {
    error: [DaemonStopping],
  },
) {}

export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "vibest/SchemaErrorMiddleware",
  {
    error: [InvalidRequestError],
  },
) {}
