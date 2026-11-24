import { EditorState } from "gpui-base"
import { settings, theme } from "herdr"

import { TEXT } from "../../shared/metrics.ts"

export interface Loaded {
  state: EditorState | null
  message: string
}

const LANG = new Map<string, string>([
  ["ts", "js"],
  ["tsx", "js"],
  ["mts", "js"],
  ["cts", "js"],
  ["jsx", "js"],
  ["mjs", "js"],
  ["toml", "yaml"],
  ["jsonc", "json"],
  ["svelte", "html"],
  ["vue", "html"],
])

const MAX_CHARS = 400000

export const editorState = (path: string, text: string): EditorState => {
  const t = theme()
  const ext = path.includes(".") ? (path.split(".").pop() ?? "txt") : "txt"

  return EditorState.new({
    language: LANG.get(ext) ?? ext,
    readonly: true,
    value: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… (file truncated)` : text,
    font_family: String(settings().font_family ?? ""),
    font_size: TEXT,
    syntax: {
      keyword: t.ansi5,
      string: t.ansi2,
      comment: t.dim,
      function: t.ansi4,
      type: t.ansi3,
      number: t.ansi1,
      constant: t.ansi6,
    },
  })
}
