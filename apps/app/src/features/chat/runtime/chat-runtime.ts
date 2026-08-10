import type {
  HarnessAgentId,
  PermissionMode,
  PromptPart,
  ReasoningEffort,
  SessionRef,
} from "@vibest/contract";
import { generateId, readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { AgentResponse } from "./agent-requests";
import type { ChatEffect, ChatInput } from "./chat-runtime-types";
import { createChatState, type ChatState } from "./chat-state";
import type { ChatSessionTransport } from "./chat-transport-port";
import { updateChat } from "./chat-update";

type PromptPromise = {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

type FoldResource = {
  readonly controller: ReadableStreamDefaultController<UIMessageChunk>;
  closed: boolean;
};

const raceWithSignal = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });

export interface ChatRuntimeInit {
  readonly sessionRef: SessionRef;
  readonly transport: ChatSessionTransport;
  readonly onTerminated?: () => void;
}

export class ChatRuntime {
  readonly harnessAgentId: HarnessAgentId;
  readonly store: StoreApi<ChatState>;

  readonly #transport: ChatSessionTransport;
  readonly #onTerminated: (() => void) | undefined;
  readonly #inputs: ChatInput[] = [];
  readonly #lifetimeController = new AbortController();
  readonly #historyControllers = new Map<number, AbortController>();
  readonly #promptPromises = new Map<string, PromptPromise>();
  readonly #responsePromises = new Map<string, () => void>();
  readonly #folds = new Map<string, FoldResource>();
  #draining = false;
  #unsubscribe: (() => void) | null = null;
  #unsubscribeRequested = false;

  constructor({ sessionRef, transport, onTerminated }: ChatRuntimeInit) {
    this.harnessAgentId = sessionRef.harnessAgentId;
    this.#transport = transport;
    this.#onTerminated = onTerminated;
    this.store = createStore<ChatState>()(() => createChatState());

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
        const currentInput = this.#inputs.shift()!;
        const currentState = this.store.getState();
        const transition = updateChat(currentState, currentInput);
        if (transition.state !== currentState) this.store.setState(transition.state, true);
        for (const effect of transition.effects) this.#runEffect(effect);
      }
    } finally {
      this.#draining = false;
    }
  }

  #runEffect(effect: ChatEffect): void {
    switch (effect.type) {
      case "readHistory":
        this.#readHistory(effect.id, effect.purpose);
        break;
      case "cancelHistory":
        this.#historyControllers.get(effect.id)?.abort();
        break;
      case "submitPrompt":
        void raceWithSignal(
          this.#transport.prompt(
            { messageId: effect.messageId, parts: effect.parts },
            { signal: this.#lifetimeController.signal },
          ),
          this.#lifetimeController.signal,
        ).then(
          () =>
            this.#send({
              type: "outgoingCompleted",
              messageId: effect.messageId,
              delivery: "follow-up",
            }),
          (error: unknown) =>
            this.#send({
              type: "outgoingCompleted",
              messageId: effect.messageId,
              delivery: "follow-up",
              error: error instanceof Error ? error : new Error(String(error)),
            }),
        );
        break;
      case "submitSteer":
        void raceWithSignal(
          this.#transport.steer(
            {
              expectedTurnId: effect.expectedTurnId,
              messageId: effect.messageId,
              parts: effect.parts,
            },
            { signal: this.#lifetimeController.signal },
          ),
          this.#lifetimeController.signal,
        ).then(
          () =>
            this.#send({
              type: "outgoingCompleted",
              messageId: effect.messageId,
              delivery: "steer",
            }),
          (error: unknown) =>
            this.#send({
              type: "outgoingCompleted",
              messageId: effect.messageId,
              delivery: "steer",
              error: error instanceof Error ? error : new Error(String(error)),
            }),
        );
        break;
      case "respondToRequest":
        void raceWithSignal(
          this.#transport.respondToAgentRequest(effect.requestId, effect.response, {
            signal: this.#lifetimeController.signal,
          }),
          this.#lifetimeController.signal,
        ).then(
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
      case "abortLifetime":
        this.#lifetimeController.abort();
        break;
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

  #readHistory(id: number, purpose: "floor" | "reconcile"): void {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.#historyControllers.set(id, controller);
    if (this.#lifetimeController.signal.aborted) abort();
    else this.#lifetimeController.signal.addEventListener("abort", abort, { once: true });

    void raceWithSignal(
      this.#transport.getMessages({ signal: controller.signal }),
      controller.signal,
    )
      .then(
        (history) => {
          this.#send({ type: "historyCompleted", id, purpose, history });
        },
        (error: unknown) => {
          this.#send({ type: "historyCompleted", id, purpose, error });
        },
      )
      .finally(() => {
        this.#lifetimeController.signal.removeEventListener("abort", abort);
        if (this.#historyControllers.get(id) === controller) {
          this.#historyControllers.delete(id);
        }
      });
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
          this.#send({ type: "foldUpdated", turnId, generation, message: message as UIMessage });
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

  steer(messageId: string): void {
    const state = this.store.getState();
    const outgoing = state.outgoing.find(
      (message) =>
        message.message.id === messageId &&
        message.delivery === "follow-up" &&
        message.status === "queued",
    );
    if (!outgoing) throw new Error("Only a queued follow-up can be steered");
    if (!state.session.activeTurnId) throw new Error("There is no active turn to steer");
    this.#send({ type: "steerRequested", messageId });
  }

  acknowledgeRecovery(recoveryId: string): Promise<void> {
    const signal = this.#lifetimeController.signal;
    return raceWithSignal(this.#transport.acknowledgeRecovery(recoveryId, { signal }), signal);
  }

  setModel(providerId: string, modelId: string): Promise<void> {
    const signal = this.#lifetimeController.signal;
    return raceWithSignal(this.#transport.setModel(providerId, modelId, { signal }), signal);
  }

  setReasoningEffort(reasoningEffort: ReasoningEffort): Promise<void> {
    const signal = this.#lifetimeController.signal;
    return raceWithSignal(this.#transport.setReasoningEffort(reasoningEffort, { signal }), signal);
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    const signal = this.#lifetimeController.signal;
    return raceWithSignal(this.#transport.setPermissionMode(mode, { signal }), signal);
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
