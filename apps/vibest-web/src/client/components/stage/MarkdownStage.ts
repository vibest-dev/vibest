import { Mount, UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Schema } from "effect"

import { ProjectFileEntrySchema, ThemeModeSchema } from "../../../domain/WebHub.ts"
import { renderSafeMarkdownHtml } from "../../../markdown-safe.ts"
import { CaptureMarkdownSelection, RenderMermaid, RenderSafeHtml } from "../../mounts/DomMounts.ts"
import { IconMessagePlus, IconX } from "../../ui/icons.ts"
import { buttonClass } from "../../ui/primitives.ts"

interface MarkdownSegment {
  readonly kind: "markdown" | "mermaid"
  readonly raw: string
}

function splitMermaidBlocks(source: string): ReadonlyArray<MarkdownSegment> {
  const segments: MarkdownSegment[] = []
  const fenceRegex = /```mermaid\s*\n([\s\S]*?)```/g
  let lastIndex = 0
  let match = fenceRegex.exec(source)

  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "markdown", raw: source.slice(lastIndex, match.index) })
    }

    segments.push({ kind: "mermaid", raw: (match[1] ?? "").trim() })
    lastIndex = match.index + match[0].length
    match = fenceRegex.exec(source)
  }

  if (lastIndex < source.length) {
    segments.push({ kind: "markdown", raw: source.slice(lastIndex) })
  }

  return segments
}

export const MarkdownStageMessage = UiSchema.TaggedEnum({
  CapturedQuote: { quote: Schema.String },
  ClickedComment: {},
  UpdatedNote: { note: Schema.String },
  ClickedAddToComposer: {},
  ClickedDismiss: {},
})

export const MarkdownStageEvents = UiSchema.TaggedEnum({
  AddedToComposer: { text: Schema.String, attachmentPath: Schema.String },
})

const MarkdownStageDef = Html.component({
  name: "MarkdownStage",
  props: Schema.Struct({
    file: ProjectFileEntrySchema,
    content: Schema.String,
    theme: ThemeModeSchema,
  }),
  model: Schema.Struct({
    selectedQuote: Schema.NullOr(Schema.String),
    note: Schema.String,
  }),
  message: MarkdownStageMessage,
  events: MarkdownStageEvents,
})

export const MarkdownStage = MarkdownStageDef.make({
  init: () => ({ selectedQuote: null, note: "" }),
  update: {
    CapturedQuote: ($, { quote }) => $.evolve({ selectedQuote: quote }),
    ClickedComment: ($) => {
      if ($.model.selectedQuote !== null) return $.model

      const heading =
        $.props.content
          .split("\n")
          .map((l) => l.replace(/^#+\s*/, "").trim())
          .find((l) => l.length > 6) ?? $.props.file.name

      return $.evolve({ selectedQuote: heading.slice(0, 120) })
    },
    UpdatedNote: ($, { note }) => $.evolve({ note }),
    ClickedAddToComposer: ($) => {
      if ($.model.selectedQuote === null) return $.model
      const rel = $.props.file.relativePath
      const payload = `[Feedback on @${rel}]\n> "${$.model.selectedQuote}"\n${$.model.note.trim() || "Please refine this section."}`

      return $.evolve({ selectedQuote: null, note: "" }).emit(
        MarkdownStageEvents.AddedToComposer({ text: payload, attachmentPath: rel }),
      )
    },
    ClickedDismiss: ($) => $.evolve({ selectedQuote: null }),
  },
  view: (h, model) => {
    const { content, theme } = h.props

    return h.div
      .attr("data-testid", "stage-markdown-view")
      .class("flex min-h-0 flex-1 flex-col")
      .children(
        h.div
          .class("flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/25 px-3 py-1.5")
          .children(
            h.span
              .class("truncate text-[11px] text-muted-foreground")
              .children("Select text or click Comment to send structured feedback to Composer."),
            h.button
              .attrs({ type: "button", "data-testid": "md-comment-btn" })
              .class(buttonClass("outline", "xs"))
              .on("click", MarkdownStageMessage.ClickedComment())
              .children(IconMessagePlus(h), "Comment to Composer"),
          ),
        model.selectedQuote !== null &&
          h.div
            .attr("data-testid", "md-composer-popover")
            .class("flex shrink-0 flex-col gap-2 border-b border-border bg-muted/40 p-2.5")
            .children(
              h.div.class("truncate font-mono text-[11px] text-info-foreground").children(`“${model.selectedQuote}”`),
              h.div.class("flex items-center gap-1.5").children(
                h.input
                  .attrs({
                    type: "text",
                    "data-testid": "md-note-input",
                    placeholder: "Write feedback for this section...",
                    "aria-label": "Markdown feedback note",
                  })
                  .class(
                    "h-7 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none",
                  )
                  .value(model.note)
                  .on("input", ({ value }) => MarkdownStageMessage.UpdatedNote({ note: value })),
                h.button
                  .attrs({ type: "button", "data-testid": "md-add-to-composer-btn" })
                  .class(buttonClass("default", "xs"))
                  .on("click", MarkdownStageMessage.ClickedAddToComposer())
                  .children("Add to Composer"),
                h.button
                  .attrs({ type: "button", "aria-label": "Dismiss feedback" })
                  .class(buttonClass("ghost", "icon-xs"))
                  .on("click", MarkdownStageMessage.ClickedDismiss())
                  .children(IconX(h)),
              ),
            ),
        h.div.class("min-h-0 flex-1 overflow-y-auto").children(
          h.div
            .class("markdown-prose px-5 py-4 text-[13px] text-foreground")
            .onMount(
              CaptureMarkdownSelection().pipe(Mount.map((quote) => MarkdownStageMessage.CapturedQuote({ quote }))),
            )
            .children(
              splitMermaidBlocks(content).map((seg, idx) =>
                seg.kind === "mermaid"
                  ? h.div
                      .key(`m-${idx}`)
                      .attr("data-testid", `stage-mermaid-${idx}`)
                      .class(
                        "my-3 flex justify-center overflow-x-auto rounded-xl border border-border bg-muted/30 p-3.5",
                      )
                      .onMount(RenderMermaid({ chart: seg.raw, index: idx, theme }))
                  : h.div.key(`md-${idx}`).onMount(RenderSafeHtml({ html: renderSafeMarkdownHtml(seg.raw) })),
              ),
            ),
        ),
      )
  },
})
