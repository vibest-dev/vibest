import { eventIterator, oc, type } from "@orpc/contract";

import {
  ArchiveSessionInputSchema,
  CreateSessionInputSchema,
  serverErrors,
  ListSessionsInputSchema,
  type ListSessionsOutput,
  PromptInputSchema,
  PromptOutputSchema,
  RefInputSchema,
  RenameSessionInputSchema,
  ResolveRefInputSchema,
  RespondToAgentRequestInputSchema,
  type SessionMessages,
  SessionRefSchema,
  type SessionRuntimeSnapshot,
  SessionStatusSchema,
  SetSessionReasoningEffortInputSchema,
  SetSessionModelInputSchema,
  SetSessionPermissionModeInputSchema,
  SteerInputSchema,
  SubscribeInputSchema,
  type SubscribeStreamEvent,
  toStandardSchema,
} from "./domain";

const base = oc.errors(serverErrors);

/**
 * SessionRef-based session contract (docs/wayfinder/session-streaming-refactor).
 * Complex outputs that embed UIMessage/UIMessageChunk (snapshot, messages,
 * list, the subscribe stream) are declared with `type<>()` and validated
 * structurally on the server rather than by a wire schema.
 */
export const sessionContract = {
  // lifecycle
  create: base
    .input(toStandardSchema(CreateSessionInputSchema))
    .output(toStandardSchema(SessionRefSchema)),
  // Neither "resume" nor "attach": it validates the ref, backfills the
  // session's cwd, and checks the harness still knows the native session. It
  // starts nothing and connects nothing — only a prompt starts a runtime, and
  // only `subscribe` attaches to the event stream.
  prepare: base.input(toStandardSchema(RefInputSchema)).output(toStandardSchema(SessionRefSchema)),
  close: base.input(toStandardSchema(RefInputSchema)),

  // history / index
  list: base.input(toStandardSchema(ListSessionsInputSchema)).output(type<ListSessionsOutput>()),
  rename: base.input(toStandardSchema(RenameSessionInputSchema)),
  archive: base.input(toStandardSchema(ArchiveSessionInputSchema)),
  delete: base.input(toStandardSchema(RefInputSchema)),
  getMessages: base.input(toStandardSchema(RefInputSchema)).output(type<SessionMessages>()),
  // sessionId (a bookmarked URL) → full SessionRef via server-side reverse lookup.
  resolveRef: base
    .input(toStandardSchema(ResolveRefInputSchema))
    .output(toStandardSchema(SessionRefSchema)),

  // active instance
  prompt: base
    .input(toStandardSchema(PromptInputSchema))
    .output(toStandardSchema(PromptOutputSchema)),
  steer: base.input(toStandardSchema(SteerInputSchema)),
  interrupt: base.input(toStandardSchema(RefInputSchema)),
  // Session-scoped config, changed via dedicated calls — never on a prompt turn.
  setModel: base.input(toStandardSchema(SetSessionModelInputSchema)),
  setReasoningEffort: base.input(toStandardSchema(SetSessionReasoningEffortInputSchema)),
  setPermissionMode: base.input(toStandardSchema(SetSessionPermissionModeInputSchema)),
  respondToAgentRequest: base.input(toStandardSchema(RespondToAgentRequestInputSchema)),
  getStatus: base
    .input(toStandardSchema(RefInputSchema))
    .output(toStandardSchema(SessionStatusSchema)),
  getSnapshot: base.input(toStandardSchema(RefInputSchema)).output(type<SessionRuntimeSnapshot>()),

  // events (scope covers both single-session and global firehose)
  subscribe: base
    .input(toStandardSchema(SubscribeInputSchema))
    .output(eventIterator(type<SubscribeStreamEvent>())),
};
