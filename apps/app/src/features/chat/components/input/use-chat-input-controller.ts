import { useCallback, useRef, useSyncExternalStore } from "react";

import { useLatestRef } from "@/hooks/use-latest-ref";

import { ChatInputController, type ChatInputControllerOptions } from "./chat-input-controller";

const getServerSnapshot = (): ChatInputController | null => null;

// The controller is a store this hook owns: subscribe constructs it, the
// unsubscribe disposes it. StrictMode subscribe/unsubscribe/subscribe creates
// and destroys a throwaway instance — a destroyed editor is never reused.
// Callbacks go through a latest-ref so closures never see stale state. First
// render returns null — consumers must tolerate it.
export function useChatInputController(
  opts: ChatInputControllerOptions,
): ChatInputController | null {
  const optsRef = useLatestRef(opts);
  const storeRef = useRef<ChatInputController | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const created = new ChatInputController({
        extensions: (self) => optsRef.current.extensions(self),
        onSubmit: (text) => optsRef.current.onSubmit(text),
      });
      storeRef.current = created;
      onStoreChange();
      return () => {
        storeRef.current = null;
        created.dispose();
        onStoreChange();
      };
    },
    [optsRef],
  );

  const getSnapshot = useCallback(() => storeRef.current, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
