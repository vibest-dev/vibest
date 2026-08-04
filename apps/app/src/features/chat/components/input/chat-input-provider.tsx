import { EditorContext } from "@tiptap/react";
import { useMemo, type ReactNode } from "react";

import type { ChatInputController } from "./chat-input-controller";

export function ChatInputProvider({
  controller,
  children,
}: {
  controller: ChatInputController | null;
  children: ReactNode;
}) {
  // `editor` is readonly on the controller, so the identity only changes when
  // the controller itself is replaced — memoising here keeps every Tiptap
  // consumer from re-rendering on unrelated parent renders.
  const value = useMemo(() => ({ editor: controller?.editor ?? null }), [controller]);
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}
