import { eventIteratorToStream } from "@orpc/client";
import type { VibestClient } from "@vibest/client";
import type {
  PromptInput,
  PromptPart,
  SessionRef,
  SessionRuntimeSnapshot,
  SubscribeStreamEvent,
} from "@vibest/contract";
import { isSessionScopedEvent } from "@vibest/contract";
import type { ChatTransport as AiChatTransport, UIMessage, UIMessageChunk } from "ai";

import type { AgentRequest, AgentResponse } from "./agent-requests";
import type { ChatSessionTransport } from "./chat-transport-port";

export type ChatModel = "opus" | "sonnet";

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

const toPromptInput = (ref: SessionRef, message: UIMessage, model: ChatModel): PromptInput => {
  const parts: PromptPart[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "data-inspector" && Array.isArray(part.data)) {
      parts.push({
        type: "data-inspector",
        data: part.data.filter(
          (target): target is { file: string; line: number; column: number } =>
            typeof target === "object" &&
            target !== null &&
            "file" in target &&
            typeof target.file === "string" &&
            "line" in target &&
            typeof target.line === "number" &&
            "column" in target &&
            typeof target.column === "number",
        ),
      });
    }
  }
  return { ref, parts, model };
};

type EventSubscription = {
  readonly events: AsyncIterable<SubscribeStreamEvent>;
  readonly close: () => void;
};

type VibestSessionClient = VibestClient["session"];

type SessionClient = Pick<
  VibestSessionClient,
  "interrupt" | "prompt" | "respondToAgentRequest" | "getSnapshot"
> & {
  subscribe: (
    ...args: Parameters<VibestSessionClient["subscribe"]>
  ) => Promise<AsyncIterable<SubscribeStreamEvent>>;
};

export type ChatTransportClient = {
  readonly session: SessionClient;
};

type PromptRecovery = {
  readonly subscription: EventSubscription;
  readonly snapshot: SessionRuntimeSnapshot;
};

// The scoped subscription has no replay: a `closed` mid-turn (slow consumer or
// server teardown) is recovered by re-fetching the snapshot — which still
// carries the active turn's buffered chunks — replaying what we haven't seen,
// then re-subscribing. `cursor` is the last session `seq` yielded, so recovery
// never double-emits.
async function* promptChunks(
  initial: EventSubscription,
  turnId: string,
  recover: () => Promise<PromptRecovery>,
  finalize: () => void,
): AsyncGenerator<UIMessageChunk> {
  let current = initial;
  let cursor = 0;
  let started = false;
  try {
    while (true) {
      let restarting = false;
      for await (const item of current.events) {
        if (item.type === "closed") {
          const recovery = await recover();
          current.close();
          current = recovery.subscription;
          const activeTurn = recovery.snapshot.activeTurn;
          if (activeTurn?.turnId === turnId) {
            // The snapshot proving our turn exists is what marks it started —
            // its buffer may legitimately still be empty (no chunk yet), and
            // `session.turn.started` will never be redelivered.
            started = true;
            for (const chunkEvent of activeTurn.chunks) {
              if (chunkEvent.seq <= cursor) continue;
              cursor = chunkEvent.seq;
              yield chunkEvent.chunk;
            }
          }
          cursor = Math.max(cursor, recovery.snapshot.cursor);
          // A newer turn replaced ours, or the session restarted → nothing more
          // for us. A retained buffer marked complete has just been fully
          // replayed → the turn is over.
          if (!activeTurn || activeTurn.turnId !== turnId || activeTurn.complete) return;
          restarting = true;
          break;
        }
        const event = item.event;
        if (!isSessionScopedEvent(event)) continue;
        if (event.seq <= cursor) continue;
        cursor = event.seq;
        switch (event.type) {
          case "session.turn.started":
            if (event.turnId === turnId) started = true;
            continue;
          case "session.message.chunk":
            if (started && event.turnId === turnId) yield event.chunk;
            continue;
          case "session.turn.ended":
            if (started && event.turnId === turnId) return;
            continue;
          case "session.crashed":
            // Crash always terminates the stream — a crash before our
            // `turn.started` arrived means the turn will never run, and no
            // further event (or `closed`) is coming to end the loop otherwise.
            return;
          default:
            continue;
        }
      }
      if (!restarting) return;
    }
  } finally {
    current.close();
    finalize();
  }
}

// One transport per Chat, bound to that session's SessionRef. The ref stays an
// object end to end; nothing here parses it out of a string. AbstractChat's
// `options.chatId` is ignored — this transport already knows its session.
export class OrpcChatSessionTransport implements ChatSessionTransport {
  readonly #ref: SessionRef;

  constructor(
    private readonly client: ChatTransportClient,
    sessionRef: SessionRef,
  ) {
    this.#ref = sessionRef;
  }

  async #subscribe(signal: AbortSignal | undefined): Promise<EventSubscription> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const events = await this.client.session.subscribe(
        { scope: { kind: "session", ref: this.#ref } },
        { signal: controller.signal },
      );
      return {
        events,
        close: () => {
          signal?.removeEventListener("abort", abort);
          abort();
        },
      };
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      throw error;
    }
  }

  async sendMessages(
    options: Parameters<AiChatTransport<UIMessage>["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const message = options.messages.at(-1);
    if (!message) throw new Error("message is required");
    const model = (options.body as { model?: ChatModel } | undefined)?.model ?? "sonnet";
    // Subscribe before prompting: the live stream has no replay, so the turn's
    // first events must not race ahead of the subscription.
    const initial = await this.#subscribe(options.abortSignal);
    try {
      const receipt = await this.client.session.prompt(toPromptInput(this.#ref, message, model), {
        signal: options.abortSignal,
      });
      const interrupt = () => {
        void this.client.session.interrupt({ ref: this.#ref }).catch((error) => {
          if (!isAbortError(error)) console.error("Failed to interrupt session", error);
        });
      };
      options.abortSignal?.addEventListener("abort", interrupt, { once: true });
      const recover = async (): Promise<PromptRecovery> => {
        const subscription = await this.#subscribe(options.abortSignal);
        try {
          const snapshot = await this.client.session.getSnapshot({ ref: this.#ref });
          return { subscription, snapshot };
        } catch (error) {
          subscription.close();
          throw error;
        }
      };
      return eventIteratorToStream(
        promptChunks(initial, receipt.turnId, recover, () =>
          options.abortSignal?.removeEventListener("abort", interrupt),
        ),
      );
    } catch (error) {
      initial.close();
      throw error;
    }
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }

  subscribeAgentRequests(
    onRequest: (request: AgentRequest) => void,
    onRequestResolved: (requestId: string) => void = () => undefined,
  ): () => void {
    const abortController = new AbortController();
    let current: EventSubscription | undefined;
    const deliveredRequestIds = new Set<string>();
    const resolvedRequestIds = new Set<string>();

    const resolveRequest = (requestId: string) => {
      resolvedRequestIds.add(requestId);
      deliveredRequestIds.delete(requestId);
      onRequestResolved(requestId);
    };

    const handleRequest = async (request: AgentRequest) => {
      if (request.type === "plan" && !request.plan.trim()) {
        void this.client.session
          .respondToAgentRequest({
            ref: this.#ref,
            requestId: request.id,
            response: { type: "plan", behavior: "allow" },
          })
          .catch((error) => {
            if (abortController.signal.aborted || resolvedRequestIds.has(request.id)) return;
            console.error("Failed to auto-approve empty plan request", error);
            deliveredRequestIds.add(request.id);
            onRequest(request);
          });
        return;
      }
      resolvedRequestIds.delete(request.id);
      deliveredRequestIds.add(request.id);
      onRequest(request);
    };

    const hydratePendingRequests = async () => {
      const snapshot = await this.client.session.getSnapshot({ ref: this.#ref });
      const pendingRequestIds = new Set(snapshot.pendingRequests.map((request) => request.id));
      for (const requestId of deliveredRequestIds) {
        if (!pendingRequestIds.has(requestId)) resolveRequest(requestId);
      }
      for (const request of snapshot.pendingRequests) await handleRequest(request);
      return snapshot.cursor;
    };

    const run = async () => {
      current = await this.#subscribe(abortController.signal);
      let cursor: number;
      try {
        cursor = await hydratePendingRequests();
      } catch (error) {
        current.close();
        throw error;
      }
      while (!abortController.signal.aborted) {
        let restarting = false;
        for await (const item of current.events) {
          if (item.type === "closed") {
            const replacement = await this.#subscribe(abortController.signal);
            try {
              cursor = Math.max(cursor, await hydratePendingRequests());
            } catch (error) {
              replacement.close();
              throw error;
            }
            current.close();
            current = replacement;
            restarting = true;
            break;
          }
          const event = item.event;
          if (!isSessionScopedEvent(event)) continue;
          if (event.seq <= cursor) continue;
          cursor = event.seq;
          if (event.type === "session.request.asked") {
            await handleRequest(event.request);
          } else if (
            event.type === "session.request.replied" ||
            event.type === "session.request.rejected"
          ) {
            resolveRequest(event.requestId);
          }
        }
        if (!restarting) return;
      }
    };

    void run().catch((streamError) => {
      if (!isAbortError(streamError)) console.error("Agent request stream error:", streamError);
    });

    return () => {
      abortController.abort();
      current?.close();
    };
  }

  async respondToAgentRequest(requestId: string, response: AgentResponse): Promise<void> {
    await this.client.session.respondToAgentRequest({
      ref: this.#ref,
      requestId,
      response,
    });
  }
}
