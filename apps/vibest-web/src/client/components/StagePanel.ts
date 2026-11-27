import { Command, Component, Mount, UiSchema } from "@effect/ui"
import { ToggleGroup } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Effect, Layer, Match, Option, Schema } from "effect"

import { renderSafeMarkdownHtml } from "../../markdown-safe.ts"
import {
  BoardNodeSchema,
  HoverTargetSchema,
  HtmlModeSchema,
  PendingHtmlFeedbackSchema,
  PointSchema,
  SessionItemSchema,
  StageItemSchema,
  ThemeModeSchema,
  type BoardNode,
  type HtmlMode,
} from "../domain/WebHub.ts"
import {
  AttachHtmlPreviewBridge,
  CaptureMarkdownSelection,
  HtmlPreviewEventSchema,
  RenderMermaid,
  RenderSafeHtml,
  TrackHtmlOverlay,
} from "../mounts/DomMounts.ts"
import { VibestWebApi } from "../services/VibestWebApi.ts"
import {
  IconBox,
  IconCircle,
  IconCrosshair,
  IconFileCode,
  IconHand,
  IconMessagePlus,
  IconPlusCircle,
  IconSave,
  IconTerminal,
  IconX,
} from "../ui/icons.ts"
import { Badge, buttonClass, Frame, FrameHeader, FramePanel, FrameTitle } from "../ui/primitives.ts"
import { WtermView } from "./WtermView.ts"

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

const ExcalidrawElementInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  backgroundColor: Schema.optional(Schema.String),
  strokeColor: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  containerId: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.String),
})

const ExcalidrawDocSchema = Schema.Struct({
  elements: Schema.optional(Schema.Array(ExcalidrawElementInputSchema)),
})

const decodeExcalidrawDoc = Schema.decodeUnknownOption(Schema.fromJsonString(ExcalidrawDocSchema))

interface ExcalidrawSerializedBox {
  readonly id: string
  readonly type: BoardNode["kind"]
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly backgroundColor: string
  readonly strokeColor: string
  readonly fillStyle: "solid"
  readonly boundElements: ReadonlyArray<{ readonly id: string; readonly type: "text" }>
}

interface ExcalidrawSerializedText {
  readonly id: string
  readonly type: "text"
  readonly containerId: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly text: string
  readonly fontSize: number
  readonly strokeColor: string
}

function parseExcalidrawNodes(raw: string): ReadonlyArray<BoardNode> {
  const decoded = decodeExcalidrawDoc(raw)

  if (Option.isNone(decoded)) return []
  const elements = decoded.value.elements ?? []
  const textByContainer = new Map<string, string>()

  for (const el of elements) {
    if (el.type === "text" && el.containerId !== undefined && el.containerId !== null && el.text !== undefined) {
      textByContainer.set(el.containerId, el.text)
    }
  }

  const nodes: BoardNode[] = []

  for (const el of elements) {
    const type = el.type

    if (type !== "rectangle" && type !== "ellipse" && type !== "diamond") continue
    const id = el.id ?? `node-${nodes.length + 1}`
    const x = el.x ?? 40
    const y = el.y ?? 40
    const width = el.width !== undefined ? Math.max(80, el.width) : 200
    const height = el.height !== undefined ? Math.max(40, el.height) : 60
    const bg = el.backgroundColor !== undefined && el.backgroundColor !== "transparent" ? el.backgroundColor : "#2563eb"
    const stroke = el.strokeColor ?? "#93c5fd"
    const label = textByContainer.get(id) ?? el.label ?? id

    nodes.push({ id, kind: type, x, y, width, height, label, backgroundColor: bg, strokeColor: stroke })
  }

  return nodes
}

function serializeExcalidrawNodes(nodes: ReadonlyArray<BoardNode>, theme: "dark" | "light"): string {
  const elements: Array<ExcalidrawSerializedBox | ExcalidrawSerializedText> = []

  for (const node of nodes) {
    const textId = `${node.id}-label`
    elements.push({
      id: node.id,
      type: node.kind,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      backgroundColor: node.backgroundColor,
      strokeColor: node.strokeColor,
      fillStyle: "solid",
      boundElements: [{ id: textId, type: "text" }],
    })
    elements.push({
      id: textId,
      type: "text",
      containerId: node.id,
      x: node.x + 12,
      y: node.y + node.height / 2 - 8,
      width: node.width - 24,
      height: 20,
      text: node.label,
      fontSize: 15,
      strokeColor: "#ffffff",
    })
  }

  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "vibest-web",
      elements,
      appState: { viewBackgroundColor: theme === "dark" ? "#111215" : "#ffffff" },
    },
    null,
    2,
  )
}

export const StagePanelMessage = UiSchema.TaggedEnum({
  SucceededLoadFile: { fileId: Schema.String, content: Schema.String, nodes: Schema.Array(BoardNodeSchema) },
  FailedLoadFile: { fileId: Schema.String },
  ClickedClose: {},
  ClickedRefreshPeek: { sessionId: Schema.String },
  CapturedMarkdownQuote: { quote: Schema.String },
  ClickedMarkdownComment: {},
  UpdatedMarkdownNote: { note: Schema.String },
  ClickedAddMarkdownFeedback: {},
  DismissedMarkdownPopover: {},
  SelectedHtmlMode: { mode: HtmlModeSchema },
  ReceivedHtmlBridgeEvent: { event: HtmlPreviewEventSchema },
  MovedHtmlPointer: { x: Schema.Number, y: Schema.Number },
  StartedHtmlDrag: { x: Schema.Number, y: Schema.Number },
  EndedHtmlDrag: { x: Schema.Number, y: Schema.Number },
  ClickedHtmlOverlay: { x: Schema.Number, y: Schema.Number },
  UpdatedHtmlNote: { note: Schema.String },
  ClickedAddHtmlFeedback: {},
  DismissedHtmlPopover: {},
  ClickedBoardAddNode: {},
  ClickedBoardSave: {},
  SucceededBoardSave: {},
  FailedBoardSave: {},
  ClickedBoardAddToComposer: {},
})

export const StagePanelEvents = UiSchema.TaggedEnum({
  RequestedRefreshPeek: { sessionId: Schema.String },
  AddedToComposer: { text: Schema.String, attachmentPath: Schema.NullOr(Schema.String) },
  RequestedClose: {},
})

export class LoadStageFile extends Command.Service<LoadStageFile>()("vibest-web/LoadStageFile", {
  args: {
    fileId: Schema.String,
    projectId: Schema.String,
    relativePath: Schema.String,
    isBoard: Schema.Boolean,
  },
  success: StagePanelMessage,
  mode: "switch",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* VibestWebApi

      return ({ fileId, projectId, relativePath, isBoard }) =>
        api.getFileContent(projectId, relativePath).pipe(
          Effect.match({
            onSuccess: (content) =>
              StagePanelMessage.SucceededLoadFile({
                fileId,
                content,
                nodes: isBoard ? parseExcalidrawNodes(content) : [],
              }),
            onFailure: () => StagePanelMessage.FailedLoadFile({ fileId }),
          }),
        )
    }),
  )
}

export class SaveStageFile extends Command.Service<SaveStageFile>()("vibest-web/SaveStageFile", {
  args: {
    projectId: Schema.String,
    relativePath: Schema.String,
    content: Schema.String,
  },
  success: StagePanelMessage,
  mode: "queue",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* VibestWebApi

      return ({ projectId, relativePath, content }) =>
        api.saveFileContent(projectId, relativePath, content).pipe(
          Effect.match({
            onSuccess: () => StagePanelMessage.SucceededBoardSave(),
            onFailure: () => StagePanelMessage.FailedBoardSave(),
          }),
        )
    }),
  )
}

const StagePanelModelSchema = Schema.Struct({
  loadedFileId: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  content: Schema.String,
  selectedQuote: Schema.NullOr(Schema.String),
  markdownNote: Schema.String,
  htmlMode: HtmlModeSchema,
  hoverTarget: Schema.NullOr(HoverTargetSchema),
  inspectPoint: Schema.NullOr(PointSchema),
  pickPoint: Schema.NullOr(PointSchema),
  pickSeq: Schema.Number,
  dragStart: Schema.NullOr(PointSchema),
  dragCurrent: Schema.NullOr(PointSchema),
  pendingHtml: Schema.NullOr(PendingHtmlFeedbackSchema),
  htmlNote: Schema.String,
  boardNodes: Schema.Array(BoardNodeSchema),
  boardSaveLabel: Schema.String,
})

const StagePanelDef = Html.component({
  name: "StagePanel",
  props: Schema.Struct({
    item: StageItemSchema,
    theme: ThemeModeSchema,
    sessions: Schema.Array(SessionItemSchema),
    peekText: Schema.String,
  }),
  model: StagePanelModelSchema,
  message: StagePanelMessage,
  events: StagePanelEvents,
})

function toHtmlMode(value: string): HtmlMode {
  if (value === "interact" || value === "circle" || value === "box") return value

  return "pick"
}

export const StagePanelNoDeps = StagePanelDef.make({
  init: ($) => {
    const base: typeof StagePanelModelSchema.Type = {
      loadedFileId: null,
      loading: false,
      content: "",
      selectedQuote: null,
      markdownNote: "",
      htmlMode: "pick",
      hoverTarget: null,
      inspectPoint: null,
      pickPoint: null,
      pickSeq: 0,
      dragStart: null,
      dragCurrent: null,
      pendingHtml: null,
      htmlNote: "",
      boardNodes: [],
      boardSaveLabel: "Saved",
    }

    if ($.props.item.kind !== "file") return base

    const file = $.props.item.file

    if (file.kind === "image" || file.kind === "video") return base

    return $.set({ ...base, loading: true, loadedFileId: file.id }).run(
      LoadStageFile.make({
        fileId: file.id,
        projectId: file.projectId,
        relativePath: file.relativePath,
        isBoard: file.kind === "excalidraw",
      }),
    )
  },
  update: {
    SucceededLoadFile: ($, { fileId, content, nodes }) =>
      $.evolve({
        loadedFileId: fileId,
        loading: false,
        content,
        boardNodes: nodes,
        boardSaveLabel: "Saved",
      }),
    FailedLoadFile: ($, { fileId }) =>
      $.evolve({
        loadedFileId: fileId,
        loading: false,
        content: "Unable to load file.",
      }),
    ClickedClose: ($) => $.emit(StagePanelEvents.RequestedClose()),
    ClickedRefreshPeek: ($, { sessionId }) => $.emit(StagePanelEvents.RequestedRefreshPeek({ sessionId })),
    CapturedMarkdownQuote: ($, { quote }) => $.evolve({ selectedQuote: quote }),
    ClickedMarkdownComment: ($) => {
      if ($.model.selectedQuote !== null) return $.model
      const fileName = $.props.item.kind === "file" ? $.props.item.file.name : "document"

      const heading =
        $.model.content
          .split("\n")
          .map((l) => l.replace(/^#+\s*/, "").trim())
          .find((l) => l.length > 6) ?? fileName

      return $.evolve({ selectedQuote: heading.slice(0, 120) })
    },
    UpdatedMarkdownNote: ($, { note }) => $.evolve({ markdownNote: note }),
    ClickedAddMarkdownFeedback: ($) => {
      if ($.props.item.kind !== "file" || $.model.selectedQuote === null) return $.model
      const rel = $.props.item.file.relativePath
      const payload = `[Feedback on @${rel}]\n> "${$.model.selectedQuote}"\n${$.model.markdownNote.trim() || "Please refine this section."}`

      return $.evolve({ selectedQuote: null, markdownNote: "" }).emit(
        StagePanelEvents.AddedToComposer({ text: payload, attachmentPath: rel }),
      )
    },
    DismissedMarkdownPopover: ($) => $.evolve({ selectedQuote: null }),
    SelectedHtmlMode: ($, { mode }) =>
      $.evolve({
        htmlMode: mode,
        hoverTarget: mode === "pick" ? $.model.hoverTarget : null,
      }),
    ReceivedHtmlBridgeEvent: ($, { event }) =>
      event.kind === "hover"
        ? $.evolve({ hoverTarget: event.target })
        : $.evolve({
            hoverTarget: event.target,
            pendingHtml: {
              kind: "element",
              label: `${event.target.tagName} ${event.target.selector}${event.target.textPreview ? ` ("${event.target.textPreview}")` : ""}`,
              left: event.target.left,
              top: event.target.top,
              width: event.target.width,
              height: event.target.height,
            },
            htmlNote: "",
          }),
    MovedHtmlPointer: ($, { x, y }) => {
      if (($.model.htmlMode === "circle" || $.model.htmlMode === "box") && $.model.dragStart !== null) {
        return $.evolve({ dragCurrent: { x, y } })
      }

      if ($.model.htmlMode === "pick") {
        return $.evolve({ inspectPoint: { x, y } })
      }

      return $.model
    },
    StartedHtmlDrag: ($, { x, y }) => {
      if ($.model.htmlMode !== "circle" && $.model.htmlMode !== "box") return $.model

      return $.evolve({
        pendingHtml: null,
        dragStart: { x, y },
        dragCurrent: { x, y },
      })
    },
    EndedHtmlDrag: ($, { x, y }) => {
      if (($.model.htmlMode !== "circle" && $.model.htmlMode !== "box") || $.model.dragStart === null) {
        return $.model
      }

      const left = Math.min($.model.dragStart.x, x)
      const top = Math.min($.model.dragStart.y, y)
      const width = Math.max(24, Math.abs(x - $.model.dragStart.x))
      const height = Math.max(24, Math.abs(y - $.model.dragStart.y))

      return $.evolve({
        dragStart: null,
        dragCurrent: null,
        pendingHtml: {
          kind: $.model.htmlMode,
          label: `${$.model.htmlMode === "circle" ? "Circle" : "Box"} region (${Math.round(left)}, ${Math.round(top)}, ${Math.round(width)}×${Math.round(height)}px)`,
          left,
          top,
          width,
          height,
        },
        htmlNote: "",
      })
    },
    ClickedHtmlOverlay: ($, { x, y }) => {
      if ($.model.htmlMode !== "pick") return $.model

      return $.evolve({
        pickPoint: { x, y },
        pickSeq: (n) => n + 1,
      })
    },
    UpdatedHtmlNote: ($, { note }) => $.evolve({ htmlNote: note }),
    ClickedAddHtmlFeedback: ($) => {
      if ($.props.item.kind !== "file" || $.model.pendingHtml === null) return $.model
      const rel = $.props.item.file.relativePath
      const formatted = `[Visual Feedback @${rel}]\nTarget: ${$.model.pendingHtml.label}\nNote: ${$.model.htmlNote.trim() || "Tighten spacing and contrast here."}`

      return $.evolve({ pendingHtml: null, htmlNote: "" }).emit(
        StagePanelEvents.AddedToComposer({ text: formatted, attachmentPath: rel }),
      )
    },
    DismissedHtmlPopover: ($) => $.evolve({ pendingHtml: null }),
    ClickedBoardAddNode: ($) => {
      const idx = $.model.boardNodes.length

      const nextNode: BoardNode = {
        id: `node-${Date.now().toString(36)}-${idx + 1}`,
        kind: "rectangle",
        x: 60 + (idx % 3) * 240,
        y: 60 + Math.floor(idx / 3) * 96,
        width: 210,
        height: 64,
        label: `Panel Gate ${idx + 1}`,
        backgroundColor: "#2563eb",
        strokeColor: "#93c5fd",
      }

      return $.evolve({
        boardNodes: (prev) => [...prev, nextNode],
        boardSaveLabel: "Unsaved",
      })
    },
    ClickedBoardSave: ($) => {
      if ($.props.item.kind !== "file") return $.model
      const file = $.props.item.file
      const payload = serializeExcalidrawNodes($.model.boardNodes, $.props.theme)

      return $.evolve({ boardSaveLabel: "Saving..." }).run(
        SaveStageFile.make({
          projectId: file.projectId,
          relativePath: file.relativePath,
          content: payload,
        }),
      )
    },
    SucceededBoardSave: ($) => $.evolve({ boardSaveLabel: "Saved" }),
    FailedBoardSave: ($) => $.evolve({ boardSaveLabel: "Save failed" }),
    ClickedBoardAddToComposer: ($) => {
      if ($.props.item.kind !== "file") return $.model
      const rel = $.props.item.file.relativePath

      return $.emit(
        StagePanelEvents.AddedToComposer({
          text: `[Architecture Board @${rel}]\nUpdated board diagram — align implementation with these panel boundaries.`,
          attachmentPath: rel,
        }),
      )
    },
  },
  view: (h, model) => {
    const { item, theme, sessions, peekText } = h.props

    if (item.kind === "terminal") {
      const session = sessions.find((s) => s.id === item.sessionId)

      return Frame(h)
        .attr("data-testid", "stage-panel")
        .children(
          FrameHeader(h).children(
            h.div
              .class("flex min-w-0 items-center gap-1.5")
              .children(
                IconTerminal(h, "size-3.5 shrink-0 text-muted-foreground"),
                FrameTitle(h, "truncate").children(`Terminal · ${session?.name ?? item.sessionId.slice(0, 8)}`),
                session?.git?.branch
                  ? Badge(h, "outline", "font-mono text-[10px]").children(session.git.branch)
                  : false,
              ),
            h.button
              .attrs({ type: "button", title: "Close Stage", "aria-label": "Close Stage" })
              .class(buttonClass("ghost", "icon-xs"))
              .on("click", StagePanelMessage.ClickedClose())
              .children(IconX(h)),
          ),
          FramePanel(h, "p-2").children(
            WtermView(h, {
              key: `stage-term-${item.sessionId}`,
              props: {
                content: peekText,
                theme,
                compact: false,
                title: `${session?.harness ?? "harness"} · ${session?.name ?? item.sessionId.slice(0, 8)}`,
                canExpand: false,
              },
              onEmit: {
                RequestedRefresh: () => StagePanelMessage.ClickedRefreshPeek({ sessionId: item.sessionId }),
                RequestedExpand: () => undefined,
              },
            }),
          ),
        )
    }

    const file = item.file
    const rawUrl = `/api/projects/${encodeURIComponent(file.projectId)}/file?path=${encodeURIComponent(file.relativePath)}&raw=1`
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

    return Frame(h)
      .attr("data-testid", "stage-panel")
      .children(
        FrameHeader(h).children(
          h.div
            .class("flex min-w-0 items-center gap-1.5")
            .children(
              IconFileCode(h, "size-3.5 shrink-0 text-muted-foreground"),
              FrameTitle(h, "truncate").children(file.name),
              Badge(h, "outline", "font-mono text-[10px]").children(file.relativePath),
            ),
          h.button
            .attrs({ type: "button", title: "Close Stage", "aria-label": "Close Stage" })
            .class(buttonClass("ghost", "icon-xs"))
            .on("click", StagePanelMessage.ClickedClose())
            .children(IconX(h)),
        ),
        FramePanel(h).children(
          model.loading
            ? h.div
                .class("flex flex-1 items-center justify-center text-xs text-muted-foreground")
                .children("Loading...")
            : file.kind === "markdown"
              ? h.div
                  .attr("data-testid", "stage-markdown-view")
                  .class("flex min-h-0 flex-1 flex-col")
                  .children(
                    h.div
                      .class(
                        "flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/25 px-3 py-1.5",
                      )
                      .children(
                        h.span
                          .class("truncate text-[11px] text-muted-foreground")
                          .children("Select text or click Comment to send structured feedback to Composer."),
                        h.button
                          .attrs({ type: "button", "data-testid": "md-comment-btn" })
                          .class(buttonClass("outline", "xs"))
                          .on("click", StagePanelMessage.ClickedMarkdownComment())
                          .children(IconMessagePlus(h), "Comment to Composer"),
                      ),
                    model.selectedQuote !== null &&
                      h.div
                        .attr("data-testid", "md-composer-popover")
                        .class("flex shrink-0 flex-col gap-2 border-b border-border bg-muted/40 p-2.5")
                        .children(
                          h.div
                            .class("truncate font-mono text-[11px] text-info-foreground")
                            .children(`“${model.selectedQuote}”`),
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
                              .value(model.markdownNote)
                              .on("input", ({ value }) => StagePanelMessage.UpdatedMarkdownNote({ note: value })),
                            h.button
                              .attrs({ type: "button", "data-testid": "md-add-to-composer-btn" })
                              .class(buttonClass("default", "xs"))
                              .on("click", StagePanelMessage.ClickedAddMarkdownFeedback())
                              .children("Add to Composer"),
                            h.button
                              .attrs({ type: "button", "aria-label": "Dismiss feedback" })
                              .class(buttonClass("ghost", "icon-xs"))
                              .on("click", StagePanelMessage.DismissedMarkdownPopover())
                              .children(IconX(h)),
                          ),
                        ),
                    h.div.class("min-h-0 flex-1 overflow-y-auto").children(
                      h.div
                        .class("markdown-prose px-5 py-4 text-[13px] text-foreground")
                        .onMount(
                          CaptureMarkdownSelection().pipe(
                            Mount.map((quote) => StagePanelMessage.CapturedMarkdownQuote({ quote })),
                          ),
                        )
                        .children(
                          splitMermaidBlocks(model.content).map((seg, idx) =>
                            seg.kind === "mermaid"
                              ? h.div
                                  .key(`m-${idx}`)
                                  .attr("data-testid", `stage-mermaid-${idx}`)
                                  .class(
                                    "my-3 flex justify-center overflow-x-auto rounded-xl border border-border bg-muted/30 p-3.5",
                                  )
                                  .onMount(RenderMermaid({ chart: seg.raw, index: idx, theme }))
                              : h.div
                                  .key(`md-${idx}`)
                                  .onMount(RenderSafeHtml({ html: renderSafeMarkdownHtml(seg.raw) })),
                          ),
                        ),
                    ),
                  )
              : file.kind === "html"
                ? h.div
                    .attr("data-testid", "stage-html-view")
                    .class("flex min-h-0 flex-1 flex-col")
                    .children(
                      h.div
                        .class(
                          "flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/25 px-2.5 py-1.5",
                        )
                        .children(
                          ToggleGroup(h, {
                            props: {
                              value: [model.htmlMode],
                              items: [{ value: "interact" }, { value: "pick" }, { value: "circle" }, { value: "box" }],
                            },
                            onEmit: ({ value }) => {
                              const next = value[0]

                              return next !== undefined
                                ? StagePanelMessage.SelectedHtmlMode({ mode: toHtmlMode(next) })
                                : undefined
                            },
                            view: (toggleGroup) =>
                              toggleGroup
                                .root(
                                  h.div
                                    .attr("aria-label", "HTML preview mode")
                                    .class(
                                      "inline-flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5",
                                    ),
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
                            .children(htmlModeHint(model.htmlMode)),
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
                              mode: model.htmlMode,
                              inspectX: model.inspectPoint?.x ?? null,
                              inspectY: model.inspectPoint?.y ?? null,
                              pickX: model.pickPoint?.x ?? null,
                              pickY: model.pickPoint?.y ?? null,
                              pickSeq: model.pickSeq,
                            }).pipe(Mount.map((event) => StagePanelMessage.ReceivedHtmlBridgeEvent({ event }))),
                          ),
                        model.htmlMode !== "interact" &&
                          h.div
                            .attr("data-testid", "html-annotation-overlay")
                            .class(
                              "absolute inset-0 z-10",
                              model.htmlMode === "pick" ? "cursor-crosshair" : "cursor-cell",
                            )
                            .onMount(
                              TrackHtmlOverlay().pipe(
                                Mount.map((ev) =>
                                  Match.value(ev.kind).pipe(
                                    Match.when("move", () => StagePanelMessage.MovedHtmlPointer({ x: ev.x, y: ev.y })),
                                    Match.when("down", () => StagePanelMessage.StartedHtmlDrag({ x: ev.x, y: ev.y })),
                                    Match.when("up", () => StagePanelMessage.EndedHtmlDrag({ x: ev.x, y: ev.y })),
                                    Match.when("click", () =>
                                      StagePanelMessage.ClickedHtmlOverlay({ x: ev.x, y: ev.y }),
                                    ),
                                    Match.exhaustive,
                                  ),
                                ),
                              ),
                            )
                            .children(
                              model.htmlMode === "pick" &&
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
                                    model.htmlMode === "circle" ? "rounded-full" : "rounded-sm",
                                  )
                                  .style({
                                    left: `${activeDragBox.left}px`,
                                    top: `${activeDragBox.top}px`,
                                    width: `${activeDragBox.width}px`,
                                    height: `${activeDragBox.height}px`,
                                  }),
                              model.pendingHtml !== null &&
                                h.div
                                  .class(
                                    "pointer-events-none absolute border-2 border-solid border-warning bg-warning/15",
                                    model.pendingHtml.kind === "circle" ? "rounded-full" : "rounded-sm",
                                  )
                                  .style({
                                    left: `${model.pendingHtml.left}px`,
                                    top: `${model.pendingHtml.top}px`,
                                    width: `${model.pendingHtml.width}px`,
                                    height: `${model.pendingHtml.height}px`,
                                  }),
                            ),
                        model.pendingHtml !== null &&
                          h.div
                            .attr("data-testid", "html-feedback-popover")
                            .class(
                              "absolute inset-x-3 bottom-3 z-20 flex flex-col gap-2 rounded-xl border border-border bg-popover p-2.5 text-popover-foreground shadow-lg",
                            )
                            .children(
                              h.div
                                .class("popover-target-label truncate font-mono text-[11px] text-info-foreground")
                                .children(model.pendingHtml.label),
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
                                  .value(model.htmlNote)
                                  .on("input", ({ value }) => StagePanelMessage.UpdatedHtmlNote({ note: value })),
                                h.button
                                  .attrs({ type: "button", "data-testid": "html-add-to-composer-btn" })
                                  .class(buttonClass("default", "xs"))
                                  .on("click", StagePanelMessage.ClickedAddHtmlFeedback())
                                  .children("Add to Composer"),
                                h.button
                                  .attrs({ type: "button", "aria-label": "Dismiss visual feedback" })
                                  .class(buttonClass("ghost", "icon-xs"))
                                  .on("click", StagePanelMessage.DismissedHtmlPopover())
                                  .children(IconX(h)),
                              ),
                            ),
                      ),
                    )
                : file.kind === "excalidraw"
                  ? h.div
                      .attr("data-testid", "stage-excalidraw-view")
                      .class("flex min-h-0 flex-1 flex-col")
                      .children(
                        h.div
                          .class(
                            "flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/25 px-2.5 py-1.5",
                          )
                          .children(
                            h.div
                              .class("flex items-center gap-1.5")
                              .children(
                                h.button
                                  .attrs({ type: "button", "data-testid": "excalidraw-add-node-btn" })
                                  .class(buttonClass("outline", "xs"))
                                  .on("click", StagePanelMessage.ClickedBoardAddNode())
                                  .children(IconPlusCircle(h), "Add Node"),
                                h.button
                                  .attrs({ type: "button", "data-testid": "excalidraw-save-btn" })
                                  .class(buttonClass("default", "xs"))
                                  .on("click", StagePanelMessage.ClickedBoardSave())
                                  .children(IconSave(h), "Save to Artifacts"),
                                h.button
                                  .attr("type", "button")
                                  .class(buttonClass("ghost", "xs"))
                                  .on("click", StagePanelMessage.ClickedBoardAddToComposer())
                                  .children(IconMessagePlus(h), "Add to Composer"),
                              ),
                            Badge(h, model.boardSaveLabel === "Saved" ? "success" : "warning")
                              .attr("data-testid", "excalidraw-save-state")
                              .children(model.boardSaveLabel),
                          ),
                        h.div
                          .class(
                            "relative min-h-0 flex-1 overflow-auto p-4",
                            theme === "dark" ? "bg-[#111215]" : "bg-white",
                          )
                          .children(
                            h.svg
                              .attrs({ viewBox: "0 0 920 560", role: "img", "aria-label": "Architecture board" })
                              .class("h-full w-full min-h-[360px]")
                              .children(
                                model.boardNodes.map((node) =>
                                  h.g.key(node.id).children(
                                    h.rect.attrs({
                                      x: String(node.x),
                                      y: String(node.y),
                                      width: String(node.width),
                                      height: String(node.height),
                                      rx: node.kind === "ellipse" ? String(node.height / 2) : "10",
                                      fill: node.backgroundColor,
                                      stroke: node.strokeColor,
                                      "stroke-width": "2",
                                    }),
                                    h.svgText
                                      .attrs({
                                        x: String(node.x + node.width / 2),
                                        y: String(node.y + node.height / 2 + 5),
                                        "text-anchor": "middle",
                                        fill: "#ffffff",
                                        "font-size": "13",
                                        "font-family": "Inter, sans-serif",
                                      })
                                      .children(node.label),
                                  ),
                                ),
                              ),
                          ),
                      )
                  : file.kind === "image"
                    ? h.div
                        .class("flex min-h-0 flex-1 items-center justify-center overflow-auto p-4")
                        .children(
                          h.img
                            .attrs({ src: rawUrl, alt: file.name })
                            .class("max-h-full max-w-full rounded-lg border border-border object-contain"),
                        )
                    : file.kind === "video"
                      ? h.div
                          .class("flex min-h-0 flex-1 items-center justify-center overflow-auto p-4")
                          .children(
                            h.video
                              .attrs({ src: rawUrl, controls: "true" })
                              .class("max-h-full max-w-full rounded-lg border border-border"),
                          )
                      : h.div
                          .class("min-h-0 flex-1 overflow-auto p-4")
                          .children(
                            h.pre
                              .class("m-0 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground")
                              .children(model.content),
                          ),
        ),
      )
  },
})

export const StagePanel = StagePanelNoDeps.pipe(
  Component.provide(Layer.mergeAll(LoadStageFile.layer, SaveStageFile.layer)),
)
