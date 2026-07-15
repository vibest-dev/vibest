import { eventIteratorToStream } from "@orpc/client";
import type { UserInputPart } from "@vibest/contract";
import type { SessionEventStreamItem } from "@vibest/contract/session";
import { isSessionEvent } from "@vibest/contract/session-events";
import type { ChatTransport as AiChatTransport, UIMessage, UIMessageChunk } from "ai";

import type { AppClients } from "@/lib/orpc";

import type { AgentRequest, AgentResponse } from "./agent-requests";

export type ChatModel = "opus" | "sonnet";

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

const emptyChunkStream = (): ReadableStream<UIMessageChunk> =>
  new ReadableStream({ start: (controller) => controller.close() });

const toUserInput = (message: UIMessage, model: ChatModel) => {
  const parts: UserInputPart[] = [];
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
  return { parts, model };
};

type EventSubscription = {
  readonly events: AsyncIterable<SessionEventStreamItem>;
  readonly close: () => void;
};

type PromptRecovery = {
  readonly subscription: EventSubscription;
  readonly snapshot: Awaited<ReturnType<AppClients["orpcClient"]["session"]["snapshot"]>>;
};

async function* promptChunks(
  initial: EventSubscription,
  receipt: { turnId: string; cursor: number },
  recover: (after: number) => Promise<PromptRecovery>,
  finalize: () => void,
): AsyncGenerator<UIMessageChunk> {
  let current = initial;
  let cursor = receipt.cursor;
  let started = false;
  try {
    while (true) {
      let restarting = false;
      for await (const item of current.events) {
        if (item.type === "gap") {
          const recovery = await recover(cursor);
          current.close();
          current = recovery.subscription;
          if (recovery.snapshot.degraded) {
            throw new Error("Session snapshot replay is degraded");
          }
          const activeTurn = recovery.snapshot.activeTurn;
          if (activeTurn?.turnId === receipt.turnId) {
            for (const envelope of activeTurn.chunks) {
              if (envelope.seq <= cursor || isSessionEvent(envelope.body)) continue;
              cursor = envelope.seq;
              yield envelope.body;
            }
          }
          cursor = Math.max(cursor, recovery.snapshot.cursor);
          if (!activeTurn || activeTurn.turnId !== receipt.turnId || activeTurn.complete) return;
          started = true;
          restarting = true;
          break;
        }
        const event = item.event;
        if (event.seq <= cursor) continue;
        cursor = event.seq;
        const body = event.body;
        if (isSessionEvent(body)) {
          if (body.type === "session.turn.started" && body.turnId === receipt.turnId) {
            started = true;
            continue;
          }
          if (
            started &&
            ((body.type === "session.turn.ended" && body.turnId === receipt.turnId) ||
              body.type === "session.crashed")
          ) {
            return;
          }
          continue;
        }
        if (started) yield body;
      }
      if (!restarting) return;
    }
  } finally {
    current.close();
    finalize();
  }
}

export class ChatTransport implements AiChatTransport<UIMessage> {
  constructor(private readonly clients: Pick<AppClients, "orpcClient" | "orpcWsClient">) {}

  async #openEvents(
    sessionId: string,
    after: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<EventSubscription> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const events = await this.clients.orpcWsClient.session.events(
        { sessionId, ...(after === undefined ? {} : { after }) },
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
    const initial = await this.#openEvents(options.chatId, undefined, options.abortSignal);
    try {
      const receipt = await this.clients.orpcClient.session.prompt(
        { sessionId: options.chatId, input: toUserInput(message, model) },
        { signal: options.abortSignal },
      );
      if (!receipt.started) {
        initial.close();
        return emptyChunkStream();
      }
      const interrupt = () => {
        void this.clients.orpcClient.session
          .interrupt({ sessionId: options.chatId })
          .catch((error) => {
            if (!isAbortError(error)) console.error("Failed to interrupt session", error);
          });
      };
      options.abortSignal?.addEventListener("abort", interrupt, { once: true });
      const recover = async (after: number): Promise<PromptRecovery> => {
        const subscription = await this.#openEvents(options.chatId, after, options.abortSignal);
        try {
          const snapshot = await this.clients.orpcClient.session.snapshot({
            sessionId: options.chatId,
          });
          return { subscription, snapshot };
        } catch (error) {
          subscription.close();
          throw error;
        }
      };
      return eventIteratorToStream(
        promptChunks(initial, receipt, recover, () =>
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
    sessionId: string,
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
        void this.clients.orpcWsClient.session
          .respondToAgentRequest({
            sessionId,
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
      const snapshot = await this.clients.orpcClient.session.snapshot({ sessionId });
      if (snapshot.degraded) throw new Error("Session snapshot replay is degraded");
      const pendingRequestIds = new Set(snapshot.pendingRequests.map((request) => request.id));
      for (const requestId of deliveredRequestIds) {
        if (!pendingRequestIds.has(requestId)) resolveRequest(requestId);
      }
      for (const request of snapshot.pendingRequests) await handleRequest(request);
      return snapshot.cursor;
    };

    const run = async () => {
      current = await this.#openEvents(sessionId, undefined, abortController.signal);
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
          if (item.type === "gap") {
            const replacement = await this.#openEvents(sessionId, cursor, abortController.signal);
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
          if (item.event.seq <= cursor) continue;
          cursor = item.event.seq;
          if (!isSessionEvent(item.event.body)) continue;
          const body = item.event.body;
          if (body.type === "session.request.asked") {
            await handleRequest(body.request);
          } else if (
            body.type === "session.request.replied" ||
            body.type === "session.request.rejected"
          ) {
            resolveRequest(body.requestId);
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

  async respondToAgentRequest(
    sessionId: string,
    requestId: string,
    response: AgentResponse,
  ): Promise<void> {
    await this.clients.orpcWsClient.session.respondToAgentRequest({
      sessionId,
      requestId,
      response,
    });
  }
}
