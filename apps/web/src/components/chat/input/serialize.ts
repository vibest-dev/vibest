import type { Editor, JSONContent } from "@tiptap/react";

export type ChatNodeTextSerializer = (node: JSONContent) => string;

// Serialization travels with the extension: a chip extension declares
// serializeText in addStorage(), collected here by extension name.
export function getChatText(editor: Editor): string {
  const serializers: Record<string, ChatNodeTextSerializer> = {};
  for (const extension of editor.extensionManager.extensions) {
    const storage = (
      editor.storage as unknown as Record<string, { serializeText?: unknown } | undefined>
    )[extension.name];
    if (typeof storage?.serializeText === "function") {
      serializers[extension.name] = storage.serializeText as ChatNodeTextSerializer;
    }
  }
  return serializeDoc(editor.getJSON(), serializers).trim();
}

// Matches ChatInputController.submit()'s send threshold: content counts only if
// there is submittable text after trim. Uses getChatText (not editor.getText)
// so chip-only documents (@mention / attachment) still count as content.
export function hasChatContent(editor: Editor): boolean {
  return getChatText(editor).trim().length > 0;
}

export function serializeDoc(
  doc: JSONContent,
  serializers: Record<string, ChatNodeTextSerializer>,
): string {
  const parts: string[] = [];
  const visit = (node: JSONContent) => {
    const custom = node.type ? serializers[node.type] : undefined;
    if (custom) {
      parts.push(custom(node));
      return;
    }
    if (node.type === "text") {
      const linkHref = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
      parts.push(linkHref ? String(linkHref) : (node.text ?? "").replace(/\u00A0/g, " "));
      return;
    }
    if (node.type === "hardBreak") {
      parts.push("\n");
      return;
    }
    if (node.type === "codeBlock") {
      parts.push(
        "```\n" + (node.content ?? []).map((child) => child.text ?? "").join("") + "\n```",
      );
      return;
    }
    node.content?.forEach(visit);
    if (node.type === "paragraph") {
      parts.push("\n");
    }
  };
  doc.content?.forEach(visit);
  return parts.join("");
}
