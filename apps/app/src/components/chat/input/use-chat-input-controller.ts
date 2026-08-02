import { useEffect, useState } from "react";

import { useLatestRef } from "@/hooks/use-latest-ref";

import { ChatInputController, type ChatInputControllerOptions } from "./chat-input-controller";

// Create the controller inside an effect (under StrictMode each effect run
// creates and disposes its own instance — a destroyed editor is never reused);
// callbacks go through a latest-ref so closures never see stale state. First
// render returns null — consumers must tolerate it.
export function useChatInputController(
  opts: ChatInputControllerOptions,
): ChatInputController | null {
  const optsRef = useLatestRef(opts);
  const [controller, setController] = useState<ChatInputController | null>(null);
  useEffect(() => {
    const created = new ChatInputController({
      extensions: (self) => optsRef.current.extensions(self),
      onSubmit: (text) => optsRef.current.onSubmit(text),
    });
    // Not an external-store subscription: the effect owns the controller's
    // lifetime (a ProseMirror editor can't be constructed during render, and
    // its teardown must run on unmount), so there is nothing to snapshot.
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-external-store-subscription
    setController(created);
    return () => {
      setController(null);
      created.dispose();
    };
    // optsRef is a stable ref; the controller's lifetime is bound to mount only.
  }, [optsRef]);
  return controller;
}
