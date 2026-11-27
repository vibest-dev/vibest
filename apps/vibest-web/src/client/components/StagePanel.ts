import { Command, Component, UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Effect, Schema } from "effect"

import { SessionItemSchema, StageItemSchema, ThemeModeSchema } from "../../domain/WebHub.ts"
import { VibestWebApi } from "../services/VibestWebApi.ts"
import { IconFileCode, IconTerminal, IconX } from "../ui/icons.ts"
import { Badge, buttonClass, Frame, FrameHeader, FramePanel, FrameTitle } from "../ui/primitives.ts"
import { ExcalidrawStage } from "./stage/ExcalidrawStage.ts"
import { HtmlPreviewStage } from "./stage/HtmlPreviewStage.ts"
import { MarkdownStage } from "./stage/MarkdownStage.ts"
import { WtermView } from "./WtermView.ts"

export const StagePanelMessage = UiSchema.TaggedEnum({
  SucceededLoadFile: { fileId: Schema.String, content: Schema.String },
  FailedLoadFile: { fileId: Schema.String },
  ClickedClose: {},
  ClickedRefreshPeek: { sessionId: Schema.String },
  AddedChildFeedback: { text: Schema.String, attachmentPath: Schema.String },
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
  },
  success: StagePanelMessage,
  mode: "switch",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* VibestWebApi

      return ({ fileId, projectId, relativePath }) =>
        api.getFileContent(projectId, relativePath).pipe(
          Effect.match({
            onSuccess: (content) => StagePanelMessage.SucceededLoadFile({ fileId, content }),
            onFailure: () => StagePanelMessage.FailedLoadFile({ fileId }),
          }),
        )
    }),
  )
}

const StagePanelDef = Html.component({
  name: "StagePanel",
  props: Schema.Struct({
    item: StageItemSchema,
    theme: ThemeModeSchema,
    sessions: Schema.Array(SessionItemSchema),
    peekText: Schema.String,
  }),
  model: Schema.Struct({
    loadedFileId: Schema.NullOr(Schema.String),
    loading: Schema.Boolean,
    content: Schema.String,
  }),
  message: StagePanelMessage,
  events: StagePanelEvents,
})

export const StagePanelNoDeps = StagePanelDef.make({
  init: ($) => {
    if ($.props.item.kind !== "file") {
      return { loadedFileId: null, loading: false, content: "" }
    }

    const file = $.props.item.file

    if (file.kind === "image" || file.kind === "video" || file.kind === "html") {
      return { loadedFileId: file.id, loading: false, content: "" }
    }

    return $.set({ loadedFileId: file.id, loading: true, content: "" }).run(
      LoadStageFile.make({
        fileId: file.id,
        projectId: file.projectId,
        relativePath: file.relativePath,
      }),
    )
  },
  update: {
    SucceededLoadFile: ($, { fileId, content }) => $.evolve({ loadedFileId: fileId, loading: false, content }),
    FailedLoadFile: ($, { fileId }) =>
      $.evolve({ loadedFileId: fileId, loading: false, content: "Unable to load file." }),
    ClickedClose: ($) => $.emit(StagePanelEvents.RequestedClose()),
    ClickedRefreshPeek: ($, { sessionId }) => $.emit(StagePanelEvents.RequestedRefreshPeek({ sessionId })),
    AddedChildFeedback: ($, { text, attachmentPath }) =>
      $.emit(StagePanelEvents.AddedToComposer({ text, attachmentPath })),
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
              ? MarkdownStage(h, {
                  key: `md:${file.id}:${file.updatedAt}`,
                  props: { file, content: model.content, theme },
                  onEmit: {
                    AddedToComposer: ({ text, attachmentPath }) =>
                      StagePanelMessage.AddedChildFeedback({ text, attachmentPath }),
                  },
                })
              : file.kind === "html"
                ? HtmlPreviewStage(h, {
                    key: `html:${file.id}:${file.updatedAt}`,
                    props: { file },
                    onEmit: {
                      AddedToComposer: ({ text, attachmentPath }) =>
                        StagePanelMessage.AddedChildFeedback({ text, attachmentPath }),
                    },
                  })
                : file.kind === "excalidraw"
                  ? ExcalidrawStage(h, {
                      key: `board:${file.id}:${file.updatedAt}`,
                      props: { file, initialContent: model.content, theme },
                      onEmit: {
                        AddedToComposer: ({ text, attachmentPath }) =>
                          StagePanelMessage.AddedChildFeedback({ text, attachmentPath }),
                      },
                    })
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

export const StagePanel = StagePanelNoDeps.pipe(Component.provide(LoadStageFile.layer))
