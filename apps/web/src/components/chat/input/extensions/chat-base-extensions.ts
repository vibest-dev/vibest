import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Paragraph } from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import { Text } from "@tiptap/extension-text";
import { UndoRedo } from "@tiptap/extensions";
import { type Extensions } from "@tiptap/react";

import { createPastePlainTextExtension } from "./paste-plain-text";

// Base extensions for the chat input: a self-owned minimal set (explicitly
// listed and maintained here instead of the StarterKit aggregate) — plain-text
// schema (Document/Paragraph/Text) + HardBreak (Shift+Enter newline) + UndoRedo
// + dynamic placeholder + paste-to-plain-text (see ./paste-plain-text).
// Deliberately no rich-text marks or block nodes.
export function createChatBaseExtensions(opts: { placeholder?: () => string } = {}): Extensions {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    UndoRedo,
    Placeholder.configure({ placeholder: () => opts.placeholder?.() ?? "" }),
    createPastePlainTextExtension(),
  ];
}
