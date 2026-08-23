import type { PromptPart } from "@vibest/contract";
import type { UIMessage } from "ai";

export type ClientQueuedPrompt = {
  readonly message: UIMessage;
  readonly parts: ReadonlyArray<PromptPart>;
};

type QueueEntry = ClientQueuedPrompt & {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

/**
 * Ephemeral, single-consumer FIFO for prompts submitted by this Chat.
 *
 * The queue owns ordering and each caller's promise. It deliberately knows
 * nothing about session phases: Chat calls dispatchNext only at a safe turn
 * boundary and supplies the actual server submission effect.
 */
export class ClientPromptQueue {
  readonly #waiting: QueueEntry[] = [];
  readonly #onChange: (messages: UIMessage[]) => void;
  #dispatching: QueueEntry | null = null;

  constructor(onChange: (messages: UIMessage[]) => void) {
    this.#onChange = onChange;
  }

  get hasWaiting(): boolean {
    return this.#waiting.length > 0;
  }

  get isDispatching(): boolean {
    return this.#dispatching !== null;
  }

  enqueue(prompt: ClientQueuedPrompt): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.#waiting.push({ ...prompt, resolve, reject });
    });
    this.#publish();
    return promise;
  }

  dispatchNext(dispatch: (prompt: ClientQueuedPrompt) => Promise<void>): Promise<void> | null {
    if (this.#dispatching) return null;
    const entry = this.#waiting.shift();
    if (!entry) return null;
    this.#dispatching = entry;
    this.#publish();

    return (async () => {
      try {
        await dispatch(entry);
        entry.resolve();
      } catch (error) {
        entry.reject(error);
      } finally {
        if (this.#dispatching === entry) this.#dispatching = null;
      }
    })();
  }

  rejectAll(error: Error): void {
    this.#dispatching?.reject(error);
    this.#dispatching = null;
    for (const entry of this.#waiting.splice(0)) entry.reject(error);
    this.#publish();
  }

  #publish(): void {
    this.#onChange(this.#waiting.map((entry) => entry.message));
  }
}
