import { ORPCError } from "@orpc/client";
import type { VibestClient } from "@vibest/client";
import type {
  PermissionMode,
  PromptPart,
  ReasoningEffort,
  SessionRef,
  SubscribeStreamEvent,
} from "@vibest/contract";
import type { UIMessage } from "ai";

import { exponentialBackoffMs } from "@/lib/utils";

import type { AgentResponse } from "./agent-requests";
import { RecoveringSubscription } from "./chat-subscription";
import type { ChatSessionTransport, ChatTransportEvent } from "./chat-transport-port";

// Backoff between subscription recoveries: 500ms doubling to a 10s ceiling,
// reset by every successful attach.
const defaultRetryDelayMs = exponentialBackoffMs(500, 10_000);

type VibestSessionClient = VibestClient["session"];

type SessionClient = Pick<
  VibestSessionClient,
  | "prompt"
  | "respondToAgentRequest"
  | "setReasoningEffort"
  | "setModel"
  | "setPermissionMode"
  | "getSnapshot"
  | "getMessages"
> & {
  subscribe: (
    ...args: Parameters<VibestSessionClient["subscribe"]>
  ) => Promise<AsyncIterable<SubscribeStreamEvent>>;
};

export type ChatTransportClient = {
  readonly session: SessionClient;
};

// One transport per Chat, bound to that session's SessionRef. The ref stays an
// object end to end; nothing here parses it out of a string.
//
// Deliberately thin: it moves wire events and RPC calls, and delegates its one
// piece of protocol knowledge — how to recover a dropped subscription — to
// RecoveringSubscription. Everything stateful about the session (cursor,
// folds, pending requests, reconcile policy) lives in Chat.
export class OrpcChatSessionTransport implements ChatSessionTransport {
  readonly #ref: SessionRef;
  readonly #retryDelayMs: (attempt: number) => number;

  constructor(
    private readonly client: ChatTransportClient,
    sessionRef: SessionRef,
    options?: { readonly retryDelayMs?: (attempt: number) => number },
  ) {
    this.#ref = sessionRef;
    this.#retryDelayMs = options?.retryDelayMs ?? defaultRetryDelayMs;
  }

  subscribe(onEvent: (event: ChatTransportEvent) => void): () => void {
    const subscription = new RecoveringSubscription({
      subscribe: (signal) =>
        this.client.session.subscribe({ scope: { kind: "session", ref: this.#ref } }, { signal }),
      getSnapshot: () => this.client.session.getSnapshot({ ref: this.#ref }),
      onEvent,
      retryDelayMs: this.#retryDelayMs,
    });
    subscription.start();
    return () => subscription.stop();
  }

  prompt = async (input: {
    readonly messageId: string;
    readonly parts: ReadonlyArray<PromptPart>;
  }): Promise<{ readonly turnId: string }> => {
    return await this.client.session.prompt({
      ref: this.#ref,
      parts: input.parts,
      messageId: input.messageId,
    });
  };

  getMessages = async (): Promise<readonly UIMessage[] | null> => {
    try {
      const result = await this.client.session.getMessages({ ref: this.#ref });
      return result.messages;
    } catch (error) {
      // Capability absence is a normal outcome, not a failure.
      if (error instanceof ORPCError && error.code === "UNSUPPORTED") return null;
      throw error;
    }
  };

  // NOT_FOUND here is "the request is no longer pending" — with several
  // clients on one session, that usually means another client answered first.
  // The outcome the responder wanted (request resolved) holds either way, so
  // it maps to success; the request.replied event closes the card everywhere.
  respondToAgentRequest = async (requestId: string, response: AgentResponse): Promise<void> => {
    try {
      await this.client.session.respondToAgentRequest({
        ref: this.#ref,
        requestId,
        response,
      });
    } catch (error) {
      if (error instanceof ORPCError && error.code === "NOT_FOUND") return;
      throw error;
    }
  };

  setModel = async (providerId: string, modelId: string): Promise<void> => {
    await this.client.session.setModel({ ref: this.#ref, providerId, modelId });
  };

  setReasoningEffort = async (reasoningEffort: ReasoningEffort): Promise<void> => {
    await this.client.session.setReasoningEffort({ ref: this.#ref, reasoningEffort });
  };

  setPermissionMode = async (permissionMode: PermissionMode): Promise<void> => {
    await this.client.session.setPermissionMode({ ref: this.#ref, permissionMode });
  };
}
