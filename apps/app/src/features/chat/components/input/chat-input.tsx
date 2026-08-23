import { EditorContent, useCurrentEditor } from "@tiptap/react";

// Thin view: renders only the edit area + input styling. The editor comes from
// ChatInputProvider; menus/toolbar/banners are composed by the consumer — no
// data flows through here.
export function ChatInput({ className }: { className?: string }) {
  const { editor } = useCurrentEditor();
  return (
    <EditorContent
      editor={editor}
      className={
        className ??
        "max-h-[6lh] w-full overflow-y-auto text-sm pointer-coarse:text-[16px] [&_.tiptap]:p-3 [&_.tiptap]:outline-none"
      }
    />
  );
}
