import { Effect } from "effect";

import type { ProjectNotFound, SessionNotFound, SessionRefMismatch } from "../errors";
import type {
  AgentUnavailable,
  ExecutableNotFound,
  HarnessAgentNotFound,
  HarnessSessionNotFound,
  SessionClosed,
} from "../harness";

/**
 * Exhaustive RPC error translation.
 *
 * `Effect.catchTags` accepts a partial handler table, so a tag added to a
 * service error union silently falls through to the transport's generic
 * internal error. `translateErrors` closes that gap: the table must carry one
 * decision per tag in the effect's error channel — translate it to a declared
 * protocol error, or write `"internal"` to keep it out of the public
 * vocabulary on purpose. Adding a tag to a service union then fails typecheck
 * at every RPC call site until a decision is written down, and removing one
 * flags the stale entry as an excess key.
 */

type TaggedError = { readonly _tag: string };

/**
 * One decision per tag: a handler that fails with a declared protocol error,
 * or the literal `"internal"` — the deliberate non-decision that lets the
 * failure surface as the transport's generic internal error.
 */
export type ErrorTranslation<E extends TaggedError> = {
  readonly [K in E["_tag"]]:
    | "internal"
    | ((error: Extract<E, { readonly _tag: K }>) => Effect.Effect<never, unknown>);
};

/**
 * The failures left after translation: handler outputs plus `"internal"`
 * passthroughs. The `error: never` parameter is how the conditional
 * recognises a function vs the `"internal"` literal — parameter types are
 * contravariant, so every real handler (`(e: SomeTag) => …`) is assignable
 * to `(error: never) => …` and we can infer its failure `F`. A looser
 * parameter type would also match `"internal"`.
 */
type Translated<E extends TaggedError, H> = {
  readonly [K in keyof H]: H[K] extends (error: never) => Effect.Effect<never, infer F>
    ? F
    : Extract<E, { readonly _tag: K }>;
}[keyof H];

export const translateErrors = <A, E extends TaggedError, R, const H extends ErrorTranslation<E>>(
  self: Effect.Effect<A, E, R>,
  // The intersection bans keys outside the error channel, so a removed
  // service error leaves a compile error, not a dead entry.
  translation: H & { readonly [K in Exclude<keyof H, E["_tag"]>]: never },
): Effect.Effect<A, Translated<E, H>, R> =>
  Effect.catch(self, (error) => {
    // The table is exhaustive by construction; the undefined arm only guards
    // against a tag smuggled past the types at runtime — refail, don't crash.
    const decision = translation[error._tag as E["_tag"]] as
      | ErrorTranslation<E>[E["_tag"]]
      | undefined;
    if (decision === undefined || decision === "internal") return Effect.fail(error);
    return decision(error as never);
  }) as Effect.Effect<A, Translated<E, H>, R>;

type MessageInput = { readonly message: string };

/** Declared INTERNAL that keeps the error's message — these end up in daemon logs and must stay diagnosable. */
export const internalWithMessage =
  <Internal>(errors: { readonly INTERNAL: (input: MessageInput) => Internal }) =>
  (error: MessageInput): Effect.Effect<never, Internal> =>
    Effect.fail(errors.INTERNAL({ message: error.message }));

// ---------------------------------------------------------------------------
// Shared translation groups for the session router. Each group is a fragment
// of a translation table: spread it where the operation's error channel
// carries those tags — the exhaustiveness check keeps every use honest.
// ---------------------------------------------------------------------------

/** `projectId` resolution: the ref names a project this server does not have. */
export const projectRefTranslation = <NotFound>(errors: {
  readonly NOT_FOUND: (input: MessageInput) => NotFound;
}) =>
  ({
    ProjectNotFound: (e: ProjectNotFound) =>
      Effect.fail(errors.NOT_FOUND({ message: `project ${e.projectId} not found` })),
  }) as const;

/**
 * SessionRef addressing: every metadata-addressed operation reads the stored
 * session record first. The repository's `SessionNotFound` means the metadata
 * is gone → NOT_FOUND (the harness's `HarnessSessionNotFound` — native session
 * not open — maps separately); a mismatched ref is a client bug; the store
 * failing to read is infrastructure.
 */
export const sessionRefTranslation = <NotFound, InvalidArgument>(errors: {
  readonly NOT_FOUND: (input: MessageInput) => NotFound;
  readonly INVALID_ARGUMENT: (input: MessageInput) => InvalidArgument;
}) =>
  ({
    SessionNotFound: (e: SessionNotFound) =>
      Effect.fail(errors.NOT_FOUND({ message: `session ${e.sessionId} not found` })),
    SessionRefMismatch: (e: SessionRefMismatch) =>
      Effect.fail(errors.INVALID_ARGUMENT({ message: `ref mismatch for session ${e.sessionId}` })),
    StoreReadError: "internal",
  }) as const;

/** Live-instance operations: the native session must be open and accepting work. */
export const activeSessionTranslation = <SessionNotActive, Internal>(errors: {
  readonly SESSION_NOT_ACTIVE: (input: MessageInput) => SessionNotActive;
  readonly INTERNAL: (input: MessageInput) => Internal;
}) =>
  ({
    HarnessSessionNotFound: (e: HarnessSessionNotFound) =>
      Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is not active` })),
    SessionClosed: (e: SessionClosed) =>
      Effect.fail(errors.SESSION_NOT_ACTIVE({ message: `session ${e.sessionId} is closed` })),
    AgentOperationError: internalWithMessage(errors),
  }) as const;

/** Opening a session: the harness itself is missing, unavailable, or has no executable. */
export const agentAvailabilityTranslation = <Unsupported>(errors: {
  readonly UNSUPPORTED: (input: MessageInput) => Unsupported;
}) =>
  ({
    HarnessAgentNotFound: (e: HarnessAgentNotFound) =>
      Effect.fail(errors.UNSUPPORTED({ message: e.message })),
    AgentUnavailable: (e: AgentUnavailable) =>
      Effect.fail(errors.UNSUPPORTED({ message: `${e.harnessAgentId}: ${e.reason}` })),
    ExecutableNotFound: (e: ExecutableNotFound) =>
      Effect.fail(errors.UNSUPPORTED({ message: e.message })),
  }) as const;

/**
 * Resume-path failures the contract deliberately keeps internal: the client
 * addressed the session correctly, but the native side could not be brought
 * back — nothing the client can branch on, so declared INTERNAL with the
 * message preserved.
 */
export const resumeInternalTranslation = <Internal>(errors: {
  readonly INTERNAL: (input: MessageInput) => Internal;
}) => {
  const toInternal = internalWithMessage(errors);
  return {
    HarnessSessionNotFound: toInternal,
    SessionNotResumable: toInternal,
    AgentOpenError: toInternal,
  } as const;
};
