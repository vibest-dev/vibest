import { Mount, UiSchema } from "@effect/ui"
import { ToggleGroup } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Match, Schema } from "effect"

import {
  HoverTargetSchema,
  HtmlModeSchema,
  PendingHtmlFeedbackSchema,
  PointSchema,
  ProjectFileEntrySchema,
  type HtmlMode,
} from "../../../domain/WebHub.ts"
import { AttachHtmlPreviewBridge, HtmlPreviewEventSchema, TrackHtmlOverlay } from "../../mounts/DomMounts.ts"
import { IconBox, IconCircle, IconCrosshair, IconHand, IconX } from "../../ui/icons.ts"
import { buttonClass } from "../../ui/primitives.ts"

const isHtmlMode = Schema.is(HtmlModeSchema)

function toHtmlMode(value: string): HtmlMode {
  return isHtmlMode(value) ? value : "pick"
}

function htmlModeHint(mode: HtmlMode): string {
  switch (mode) {
    case "pick":
      return "Hover and click any DOM element to capture its CSS selector."
    case "circle":
      return "Drag a circle over a visual region to annotate."
    case "box":
      return "Drag a box over a visual region to annotate."
    case "interact":
      return "Interactive sandboxed HTML preview."
  }
}

export const HtmlPreviewStageMessage = UiSchema.TaggedEnum({
  SelectedMode: { mode: HtmlModeSchema },
  ReceivedBridgeEvent: { event: HtmlPreviewEventSchema },
  MovedPointer: { x: Schema.Number, y: Schema.Number },
  StartedDrag: { x: Schema.Number, y: Schema.Number },
  EndedDrag: { x: Schema.Number, y: Schema.Number },
  ClickedOverlay: { x: Schema.Number, y: Schema.Number },
  UpdatedNote: { note: Schema.String },
  ClickedAddToComposer: {},
  ClickedDismiss: {},
})

export const HtmlPreviewStageEvents = UiSchema.TaggedEnum({
  AddedToComposer: { text: Schema.String, attachmentPath: Schema.String },
})

const HtmlPreviewStageDef = Html.component({
  name: "HtmlPreviewStage",
  props: Schema.Struct({
    file: ProjectFileEntrySchema,
  }),
  model: Schema.Struct({
    mode: HtmlModeSchema,
    hoverTarget: Schema.NullOr(HoverTargetSchema),
    inspectPoint: Schema.NullOr(PointSchema),
    pickPoint: Schema.NullOr(PointSchema),
    pickSeq: Schema.Number,
    dragStart: Schema.NullOr(PointSchema),
    dragCurrent: Schema.NullOr(PointSchema),
    pending: Schema.NullOr(PendingHtmlFeedbackSchema),
    note: Schema.String,
  }),
  message: HtmlPreviewStageMessage,
  events: HtmlPreviewStageEvents,
})

export const HtmlPreviewStage = HtmlPreviewStageDef.make({
  init: () => ({
    mode: "pick",
    hoverTarget: null,
    inspectPoint: null,
    pickPoint: null,
    pickSeq: 0,
    dragStart: null,
    dragCurrent: null,
    pending: null,
    note: "",
  }),
  update: {
    SelectedMode: ($, { mode }) =>
      $.evolve({
        mode,
        hoverTarget: mode === "pick" ? $.model.hoverTarget : null,
      }),
    ReceivedBridgeEvent: ($, { event }) =>
      event.kind === "hover"
        ? $.evolve({ hoverTarget: event.target })
        : $.evolve({
            hoverTarget: event.target,
            pending: {
              kind: "element",
              label: `${event.target.tagName} ${event.target.selector}${event.target.textPreview ? ` ("${event.target.textPreview}")` : ""}`,
              left: event.target.left,
              top: event.target.top,
              width: event.target.width,
              height: event.target.height,
            },
            note: "",
          }),
    MovedPointer: ($, { x, y }) => {
      if (($.model.mode === "circle" || $.model.mode === "box") && $.model.dragStart !== null) {
        return $.evolve({ dragCurrent: { x, y } })
      }

      if ($.model.mode === "pick") {
        return $.evolve({ inspectPoint: { x, y } })
      }

      return $.model
    },
    StartedDrag: ($, { x, y }) => {
      if ($.model.mode !== "circle" && $.model.mode !== "box") return $.model

      return $.evolve({
        pending: null,
        dragStart: { x, y },
        dragCurrent: { x, y },
      })
    },
    EndedDrag: ($, { x, y }) => {
      if (($.model.mode !== "circle" && $.model.mode !== "box") || $.model.dragStart === null) {
        return $.model
      }

      const left = Math.min($.model.dragStart.x, x)
      const top = Math.min($.model.dragStart.y, y)
      const width = Math.max(24, Math.abs(x - $.model.dragStart.x))
      const height = Math.max(24, Math.abs(y - $.model.dragStart.y))

      return $.evolve({
        dragStart: null,
        dragCurrent: null,
        pending: {
          kind: $.model.mode,
          label: `${$.model.mode === "circle" ? "Circle" : "Box"} region (${Math.round(left)}, ${Math.round(top)}, ${Math.round(width)}×${Math.round(height)}px)`,
          left,
          top,
          width,
          height,
        },
        note: "",
      })
    },
    ClickedOverlay: ($, { x, y }) => {
      if ($.model.mode !== "pick") return $.model

      return $.evolve({
        pickPoint: { x, y },
        pickSeq: (n) => n + 1,
      })
    },
    UpdatedNote: ($, { note }) => $.evolve({ note }),
    ClickedAddToComposer: ($) => {
      if ($.model.pending === null) return $.model
      const rel = $.props.file.relativePath
      const formatted = `[Visual Feedback @${rel}]\nTarget: ${$.model.pending.label}\nNote: ${$.model.note.trim() || "Tighten spacing and contrast here."}`

      return $.evolve({ pending: null, note: "" }).emit(
        HtmlPreviewStageEvents.AddedToComposer({ text: formatted, attachmentPath: rel }),
      )
    },
    ClickedDismiss: ($) => $.evolve({ pending: null }),
  },
  view: (h, model) => {
    const { file } = h.props
    const previewUrl = `/api/projects/${encodeURIComponent(file.projectId)}/preview?path=${encodeURIComponent(file.relativePath)}`

    const activeDragBox =
      model.dragStart !== null && model.dragCurrent !== null
        ? {
            left: Math.min(model.dragStart.x, model.dragCurrent.x),
            top: Math.min(model.dragStart.y, model.dragCurrent.y),
            width: Math.abs(model.dragCurrent.x - model.dragStart.x),
            height: Math.abs(model.dragCurrent.y - model.dragStart.y),
          }
        : null

    return h.div
      .attr("data-testid", "stage-html-view")
      .class("flex min-h-0 flex-1 flex-col")
      .children(
        h.div
          .class("flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/25 px-2.5 py-1.5")
          .children(
            ToggleGroup(h, {
              props: {
                value: [model.mode],
                items: [{ value: "interact" }, { value: "pick" }, { value: "circle" }, { value: "box" }],
              },
              onEmit: ({ value }) => {
                const next = value[0]

                return next !== undefined ? HtmlPreviewStageMessage.SelectedMode({ mode: toHtmlMode(next) }) : undefined
              },
              view: (toggleGroup) =>
                toggleGroup
                  .root(
                    h.div
                      .attr("aria-label", "HTML preview mode")
                      .class("inline-flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5"),
                  )
                  .children(
                    toggleGroup
                      .item({
                        element: h.button
                          .attrs({ type: "button", "data-testid": "html-mode-interact" })
                          .class(
                            "inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors data-[pressed]:bg-accent data-[pressed]:text-foreground",
                          ),
                        value: "interact",
                      })
                      .children(IconHand(h), "Interact"),
                    toggleGroup
                      .item({
                        element: h.button
                          .attrs({ type: "button", "data-testid": "html-mode-pick" })
                          .class(
                            "inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors data-[pressed]:bg-accent data-[pressed]:text-foreground",
                          ),
                        value: "pick",
                      })
                      .children(IconCrosshair(h), "Pick Element"),
                    toggleGroup
                      .item({
                        element: h.button
                          .attrs({ type: "button", "data-testid": "html-mode-circle" })
                          .class(
                            "inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors data-[pressed]:bg-accent data-[pressed]:text-foreground",
                          ),
                        value: "circle",
                      })
                      .children(IconCircle(h), "Circle"),
                    toggleGroup
                      .item({
                        element: h.button
                          .attrs({ type: "button", "data-testid": "html-mode-box" })
                          .class(
                            "inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors data-[pressed]:bg-accent data-[pressed]:text-foreground",
                          ),
                        value: "box",
                      })
                      .children(IconBox(h), "Box"),
                  ),
            }),
            h.span
              .class("hidden truncate text-[11px] text-muted-foreground lg:inline")
              .children(htmlModeHint(model.mode)),
          ),
        h.div.class("relative min-h-0 flex-1 bg-white").children(
          h.iframe
            .attrs({
              src: previewUrl,
              title: file.name,
              sandbox: "allow-scripts",
            })
            .class("html-preview-iframe block size-full border-0")
            .onMount(
              AttachHtmlPreviewBridge({
                mode: model.mode,
                inspectX: model.inspectPoint?.x ?? null,
                inspectY: model.inspectPoint?.y ?? null,
                pickX: model.pickPoint?.x ?? null,
                pickY: model.pickPoint?.y ?? null,
                pickSeq: model.pickSeq,
              }).pipe(Mount.map((event) => HtmlPreviewStageMessage.ReceivedBridgeEvent({ event }))),
            ),
          model.mode !== "interact" &&
            h.div
              .attr("data-testid", "html-annotation-overlay")
              .class("absolute inset-0 z-10", model.mode === "pick" ? "cursor-crosshair" : "cursor-cell")
              .onMount(
                TrackHtmlOverlay().pipe(
                  Mount.map((ev) =>
                    Match.value(ev.kind).pipe(
                      Match.when("move", () => HtmlPreviewStageMessage.MovedPointer({ x: ev.x, y: ev.y })),
                      Match.when("down", () => HtmlPreviewStageMessage.StartedDrag({ x: ev.x, y: ev.y })),
                      Match.when("up", () => HtmlPreviewStageMessage.EndedDrag({ x: ev.x, y: ev.y })),
                      Match.when("click", () => HtmlPreviewStageMessage.ClickedOverlay({ x: ev.x, y: ev.y })),
                      Match.exhaustive,
                    ),
                  ),
                ),
              )
              .children(
                model.mode === "pick" &&
                  model.hoverTarget !== null &&
                  h.div
                    .class("pointer-events-none absolute rounded-sm border-2 border-info bg-info/15")
                    .style({
                      left: `${model.hoverTarget.left}px`,
                      top: `${model.hoverTarget.top}px`,
                      width: `${model.hoverTarget.width}px`,
                      height: `${model.hoverTarget.height}px`,
                    })
                    .children(
                      h.span
                        .class(
                          "absolute -top-5 left-0 rounded bg-info px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-white",
                        )
                        .children(model.hoverTarget.selector),
                    ),
                activeDragBox !== null &&
                  h.div
                    .class(
                      "pointer-events-none absolute border-2 border-dashed border-warning bg-warning/15",
                      model.mode === "circle" ? "rounded-full" : "rounded-sm",
                    )
                    .style({
                      left: `${activeDragBox.left}px`,
                      top: `${activeDragBox.top}px`,
                      width: `${activeDragBox.width}px`,
                      height: `${activeDragBox.height}px`,
                    }),
                model.pending !== null &&
                  h.div
                    .class(
                      "pointer-events-none absolute border-2 border-solid border-warning bg-warning/15",
                      model.pending.kind === "circle" ? "rounded-full" : "rounded-sm",
                    )
                    .style({
                      left: `${model.pending.left}px`,
                      top: `${model.pending.top}px`,
                      width: `${model.pending.width}px`,
                      height: `${model.pending.height}px`,
                    }),
              ),
          model.pending !== null &&
            h.div
              .attr("data-testid", "html-feedback-popover")
              .class(
                "absolute inset-x-3 bottom-3 z-20 flex flex-col gap-2 rounded-xl border border-border bg-popover p-2.5 text-popover-foreground shadow-lg",
              )
              .children(
                h.div
                  .class("popover-target-label truncate font-mono text-[11px] text-info-foreground")
                  .children(model.pending.label),
                h.div.class("flex items-center gap-1.5").children(
                  h.input
                    .attrs({
                      type: "text",
                      "data-testid": "html-feedback-input",
                      placeholder: "Describe visual adjustment...",
                      "aria-label": "Visual adjustment note",
                    })
                    .class(
                      "h-7 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none",
                    )
                    .value(model.note)
                    .on("input", ({ value }) => HtmlPreviewStageMessage.UpdatedNote({ note: value })),
                  h.button
                    .attrs({ type: "button", "data-testid": "html-add-to-composer-btn" })
                    .class(buttonClass("default", "xs"))
                    .on("click", HtmlPreviewStageMessage.ClickedAddToComposer())
                    .children("Add to Composer"),
                  h.button
                    .attrs({ type: "button", "aria-label": "Dismiss visual feedback" })
                    .class(buttonClass("ghost", "icon-xs"))
                    .on("click", HtmlPreviewStageMessage.ClickedDismiss())
                    .children(IconX(h)),
                ),
              ),
        ),
      )
  },
})
