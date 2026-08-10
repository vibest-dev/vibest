import type {
  HarnessAgentId,
  PermissionMode,
  PromptPart,
  ReasoningEffort,
  SessionRef,
} from "@vibest/contract";
import { generateId, readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import type { StoreApi } from "zustand/vanilla";

import type { AgentResponse } from "./agent-requests";
import { createChatState, type ChatState } from "./chat-state";
import type { ChatSessionTransport } from "./chat-transport-port";
import { updateChat, type ChatEffect, type ChatInput } from "./chat-update";
import { buildChatView, ChatViewStore, type ChatView } from "./chat-view";

type PromptPromise = {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

type FoldResource = {
  readonly controller: ReadableStreamDefaultController<UIMessageChunk>;
  closed: boolean;
};

export interface ChatRuntimeInit {
  readonly sessionRef: SessionRef;
  readonly transport: ChatSessionTransport;
  readonly onTerminated?: () => void;
}

export class ChatRuntime {
  readonly harnessAgentId: HarnessAgentId;
  readonly store: StoreApi<ChatView>;

  readonly #transport: ChatSessionTransport;
  readonly #onTerminated: (() => void) | undefined;
  readonly #viewStore: ChatViewStore;
  readonly #inputs: ChatInput[] = [];
  readonly #promptPromises = new Map<string, PromptPromise>();
  readonly #responsePromises = new Map<string, () => void>();
  readonly #folds = new Map<string, FoldResource>();
  #state: ChatState;
  #draining = false;
  #unsubscribe: (() => void) | null = null;
  #unsubscribeRequested = false;

  constructor({ sessionRef, transport, onTerminated }: ChatRuntimeInit) {
    this.harnessAgentId = sessionRef.harnessAgentId;
    this.#transport = transport;
    this.#onTerminated = onTerminated;
    this.#state = createChatState();
    this.#viewStore = new ChatViewStore(buildChatView(this.#state));
    this.store = this.#viewStore.store;

    const unsubscribe = transport.subscribe((event) => {
      this.#send({ type: "transportEvent", event });
    });
    if (this.#unsubscribeRequested) unsubscribe();
    else this.#unsubscribe = unsubscribe;
  }

  #send(input: ChatInput): void {
    this.#inputs.push(input);
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#inputs.length > 0) {
        const current = this.#inputs.shift()!;
        const transition = updateChat(this.#state, current);
        if (transition.state !== this.#state) {
          this.#state = transition.state;
          this.#viewStore.publish(buildChatView(this.#state));
        }
        for (const effect of transition.effects) this.#runEffect(effect);
      }
    } finally {
      this.#draining = false;
    }
  }

  #runEffect(effect: ChatEffect): void {
    switch (effect.type) {
      case "readHistory":
        void this.#transport.getMessages().then(
          (history) => {
            this.#send({
              type: "historyCompleted",
              id: effect.id,
              purpose: effect.purpose,
              history,
            });
          },
          (error: unknown) => {
            this.#send({
              type: "historyCompleted",
              id: effect.id,
              purpose: effect.purpose,
              error,
            });
          },
        );
        break;
      case "submitPrompt":
        void this.#transport.prompt({ messageId: effect.messageId, parts: effect.parts }).then(
          () => this.#send({ type: "promptCompleted", messageId: effect.messageId }),
          (error: unknown) =>
            this.#send({
              type: "promptCompleted",
              messageId: effect.messageId,
              error: error instanceof Error ? error : new Error(String(error)),
            }),
        );
        break;
      case "respondToRequest":
        void this.#transport.respondToAgentRequest(effect.requestId, effect.response).then(
          () =>
            this.#send({
              type: "requestResponseCompleted",
              operationId: effect.operationId,
            }),
          (error: unknown) =>
            this.#send({
              type: "requestResponseCompleted",
              operationId: effect.operationId,
              error,
            }),
        );
        break;
      case "openFold":
        this.#openFold(effect.turnId, effect.generation);
        break;
      case "appendFold": {
        const fold = this.#folds.get(this.#foldKey(effect.turnId, effect.generation));
        if (fold && !fold.closed) fold.controller.enqueue(effect.chunk);
        break;
      }
      case "closeFold": {
        const fold = this.#folds.get(this.#foldKey(effect.turnId, effect.generation));
        if (fold && !fold.closed) {
          fold.closed = true;
          fold.controller.close();
        }
        break;
      }
      case "resolvePrompt": {
        const promise = this.#promptPromises.get(effect.messageId);
        this.#promptPromises.delete(effect.messageId);
        promise?.resolve();
        break;
      }
      case "rejectPrompt": {
        const promise = this.#promptPromises.get(effect.messageId);
        this.#promptPromises.delete(effect.messageId);
        promise?.reject(effect.error);
        break;
      }
      case "settleResponse": {
        const resolve = this.#responsePromises.get(effect.operationId);
        this.#responsePromises.delete(effect.operationId);
        resolve?.();
        break;
      }
      case "unsubscribe":
        this.#unsubscribeRequested = true;
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        break;
      case "notifyTerminated":
        this.#onTerminated?.();
        break;
      case "logError":
        console.error(effect.message, effect.error);
        break;
    }
  }

  #foldKey(turnId: string, generation: number): string {
    return `${turnId}:${generation}`;
  }

  #openFold(turnId: string, generation: number): void {
    const key = this.#foldKey(turnId, generation);
    if (this.#folds.has(key)) return;
    let controller: ReadableStreamDefaultController<UIMessageChunk> | undefined;
    const stream = new ReadableStream<UIMessageChunk>({
      start(value) {
        controller = value;
      },
    });
    if (!controller) throw new Error("Chat fold stream did not start");
    this.#folds.set(key, { controller, closed: false });
    void (async () => {
      let foldError: unknown;
      try {
        const seed = { id: `turn-${turnId}`, role: "assistant", parts: [] } as UIMessage;
        for await (const message of readUIMessageStream({ message: seed, stream })) {
          this.#send({
            type: "foldUpdated",
            turnId,
            generation,
            message: message as UIMessage,
          });
        }
      } catch (error) {
        foldError = error;
      } finally {
        this.#folds.delete(key);
        this.#send({ type: "foldFinished", turnId, generation, error: foldError });
      }
    })();
  }

  prompt(text: string): Promise<void> {
    const parts: PromptPart[] = [{ type: "text", text }];
    const message: UIMessage = { id: generateId(), role: "user", parts };
    const promise = new Promise<void>((resolve, reject) => {
      this.#promptPromises.set(message.id, { resolve, reject });
    });
    this.#send({ type: "promptRequested", message, parts });
    return promise;
  }

  setModel(providerId: string, modelId: string): Promise<void> {
    return this.#transport.setModel(providerId, modelId);
  }

  setReasoningEffort(reasoningEffort: ReasoningEffort): Promise<void> {
    return this.#transport.setReasoningEffort(reasoningEffort);
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    return this.#transport.setPermissionMode(mode);
  }

  respondToAgentRequest(requestId: string, response: AgentResponse): Promise<void> {
    const operationId = generateId();
    const promise = new Promise<void>((resolve) => {
      this.#responsePromises.set(operationId, resolve);
    });
    this.#send({ type: "requestResponseStarted", operationId, requestId, response });
    return promise;
  }

  dispose(): void {
    this.#send({ type: "dispose" });
  }
}
