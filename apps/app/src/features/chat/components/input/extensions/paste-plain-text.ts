import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Extension } from "@tiptap/react";

// Paste-to-plain-text: the plain-text schema already downgrades pasted rich
// text (bold / lists / blocks are stripped automatically) — the only loss is
// the <a> URL, since only the anchor text survives by default. This replaces
// links with their href (allow-listed protocols; invalid falls back to the
// anchor text) and leaves the rest to the schema's default parsing.
export function createPastePlainTextExtension() {
  return Extension.create({
    name: "chatPastePlainText",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("chatPastePlainText"),
          props: {
            transformPastedHTML: rewritePastedLinksToHref,
          },
        }),
      ];
    },
  });
}

function isValidUrl(str: string): boolean {
  try {
    return ["http:", "https:", "ftp:"].includes(new URL(str).protocol);
  } catch {
    return false;
  }
}

// The returned HTML gets re-parsed by ProseMirror's clipboard parser against
// the schema.
export function rewritePastedLinksToHref(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const anchor of doc.querySelectorAll("a")) {
    const href = anchor.getAttribute("href");
    const text = href && isValidUrl(href) ? href : (anchor.textContent ?? "");
    anchor.replaceWith(doc.createTextNode(text));
  }
  return doc.body.innerHTML;
}
