import { UiSchema } from "@effect/ui"
import { Collapsible, Popover, Select, Tabs } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Predicate, Schema } from "effect"

import {
  ProjectFileEntrySchema,
  ProjectSummarySchema,
  SessionItemSchema,
  StageModeSchema,
  TimelineEntrySchema,
  type StageMode,
} from "../../domain/WebHub.ts"
import { renderSafeMarkdownHtml } from "../../markdown-safe.ts"
import { parseVibestMessageBlocks } from "../../xml-parser.ts"
import { RenderSafeHtml, SyncTextareaHeight } from "../mounts/DomMounts.ts"
import {
  IconAtSign,
  IconBot,
  IconChevronDown,
  IconChevronRight,
  IconColumns,
  IconFileText,
  IconGitBranch,
  IconMessageSquare,
  IconPanelRight,
  IconSend,
  IconSparkles,
  IconTerminal,
  IconX,
} from "../ui/icons.ts"
import {
  Badge,
  buttonClass,
  EmptyState,
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
  TabsListClass,
  TabsTabClass,
} from "../ui/primitives.ts"

function formatTime(ms: number): string {
  const date = new Date(ms)

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function initialsOf(label: string): string {
  const clean = label.trim()

  if (clean.length === 0) return "VB"

  return clean.slice(0, 2).toUpperCase()
}

const isStageMode = Schema.is(StageModeSchema)

function toStageMode(value: string): StageMode {
  return isStageMode(value) ? value : "chat"
}

export const ChatPanelMessage = UiSchema.TaggedEnum({
  SelectedStageMode: { mode: StageModeSchema },
  UpdatedComposerText: { text: Schema.String },
  SubmittedComposer: {},
  RequestedOpenAtPopover: {},
  RequestedCloseAtPopover: {},
  UpdatedAtFilter: { filter: Schema.String },
  PickedAttachment: { relativePath: Schema.String },
  ClickedRemoveAttachment: { relativePath: Schema.String },
  RequestedOpenTargetSelect: {},
  RequestedCloseTargetSelect: {},
  PickedTargetSession: { sessionId: Schema.String },
  ToggledAgentReport: { reportKey: Schema.String },
  ClickedPeekSession: { sessionId: Schema.String },
  ClickedFocusSession: { sessionId: Schema.String },
})

export const ChatPanelEvents = UiSchema.TaggedEnum({
  RequestedStageMode: { mode: StageModeSchema },
  RequestedTargetSession: { sessionId: Schema.String },
  RequestedComposerText: { text: Schema.String },
  RequestedAddAttachment: { relativePath: Schema.String },
  RequestedRemoveAttachment: { relativePath: Schema.String },
  RequestedSend: {},
  RequestedPeekSession: { sessionId: Schema.String },
  RequestedFocusSession: { sessionId: Schema.String },
})

const ChatPanelDef = Html.component({
  name: "ChatPanel",
  props: Schema.Struct({
    project: Schema.NullOr(ProjectSummarySchema),
    sessions: Schema.Array(SessionItemSchema),
    activeSessionId: Schema.NullOr(Schema.String),
    targetSessionId: Schema.NullOr(Schema.String),
    timeline: Schema.Array(TimelineEntrySchema),
    projectFiles: Schema.Array(ProjectFileEntrySchema),
    stageMode: StageModeSchema,
    hasStageItem: Schema.Boolean,
    composerText: Schema.String,
    attachedPaths: Schema.Array(Schema.String),
    sending: Schema.Boolean,
  }),
  model: Schema.Struct({
    atOpen: Schema.Boolean,
    atFilter: Schema.String,
    targetSelectOpen: Schema.Boolean,
    expandedReports: Schema.Record(Schema.String, Schema.Boolean),
  }),
  message: ChatPanelMessage,
  events: ChatPanelEvents,
})

export const ChatPanel = ChatPanelDef.make({
  init: () => ({
    atOpen: false,
    atFilter: "",
    targetSelectOpen: false,
    expandedReports: {},
  }),
  update: {
    SelectedStageMode: ($, { mode }) => $.emit(ChatPanelEvents.RequestedStageMode({ mode })),
    UpdatedComposerText: ($, { text }) =>
      $.evolve({ atOpen: (open) => (text.endsWith("@") ? true : open) }).emit(
        ChatPanelEvents.RequestedComposerText({ text }),
      ),
    SubmittedComposer: ($) => $.emit(ChatPanelEvents.RequestedSend()),
    RequestedOpenAtPopover: ($) => $.evolve({ atOpen: true }),
    RequestedCloseAtPopover: ($) => $.evolve({ atOpen: false }),
    UpdatedAtFilter: ($, { filter }) => $.evolve({ atFilter: filter }),
    PickedAttachment: ($, { relativePath }) =>
      $.evolve({ atOpen: false, atFilter: "" }).emit(ChatPanelEvents.RequestedAddAttachment({ relativePath })),
    ClickedRemoveAttachment: ($, { relativePath }) =>
      $.emit(ChatPanelEvents.RequestedRemoveAttachment({ relativePath })),
    RequestedOpenTargetSelect: ($) => $.evolve({ targetSelectOpen: true }),
    RequestedCloseTargetSelect: ($) => $.evolve({ targetSelectOpen: false }),
    PickedTargetSession: ($, { sessionId }) =>
      $.evolve({ targetSelectOpen: false }).emit(ChatPanelEvents.RequestedTargetSession({ sessionId })),
    ToggledAgentReport: ($, { reportKey }) =>
      $.evolve({
        expandedReports: (prev) => ({ ...prev, [reportKey]: !prev[reportKey] }),
      }),
    ClickedPeekSession: ($, { sessionId }) => $.emit(ChatPanelEvents.RequestedPeekSession({ sessionId })),
    ClickedFocusSession: ($, { sessionId }) => $.emit(ChatPanelEvents.RequestedFocusSession({ sessionId })),
  },
  view: (h, model) => {
    const {
      project,
      sessions,
      activeSessionId,
      targetSessionId,
      timeline,
      projectFiles,
      stageMode,
      hasStageItem,
      composerText,
      attachedPaths,
      sending,
    } = h.props

    const sessionById = new Map(sessions.map((s) => [s.id, s]))

    const activeSession = activeSessionId !== null ? sessionById.get(activeSessionId) : undefined
    const targetSession = targetSessionId !== null ? sessionById.get(targetSessionId) : undefined

    const atQuery = model.atFilter.trim().toLowerCase()

    const filteredFiles = projectFiles.filter(
      (f) =>
        !attachedPaths.includes(f.relativePath) &&
        (atQuery.length === 0 ||
          f.relativePath.toLowerCase().includes(atQuery) ||
          f.name.toLowerCase().includes(atQuery)),
    )

    const selectItems = sessions.map((s) => ({
      value: s.id,
      label: s.isEntry ? `Entry · ${s.name}` : `${s.name} (${s.git?.branch || s.harness})`,
    }))

    return Frame(h)
      .attr("data-testid", "chat-panel")
      .children(
        FrameHeader(h).children(
          h.div
            .class("flex min-w-0 items-center gap-1.5")
            .children(
              IconMessageSquare(h, "size-3.5 shrink-0 text-muted-foreground"),
              FrameTitle(h, "truncate").children(`Vibest/${project?.name ?? "workspace"}`),
              project !== null &&
                project.branch.length > 0 &&
                Badge(h, "outline", "gap-1 font-mono text-[10px]").children(IconGitBranch(h), project.branch),
              activeSession !== undefined &&
                Badge(h, "secondary", "hidden font-mono text-[10px] sm:inline-flex").children(
                  `${activeSession.harness}${activeSession.model ? ` · ${activeSession.model}` : ""}`,
                ),
            ),
          Tabs(h, {
            props: {
              value: stageMode,
              tabs: [
                { value: "chat" },
                { value: "split", disabled: !hasStageItem },
                { value: "stage", disabled: !hasStageItem },
              ],
            },
            onEmit: {
              Selected: ({ value }) => ChatPanelMessage.SelectedStageMode({ mode: toStageMode(value) }),
            },
            view: (tabs) =>
              tabs.root(h.div).children(
                tabs.list(h.div.attr("aria-label", "Center workspace layout").class(TabsListClass)).children(
                  tabs
                    .tab({
                      element: h.button.class(TabsTabClass).attr("data-testid", "mode-chat-btn"),
                      value: "chat",
                    })
                    .children(IconMessageSquare(h, "size-3"), "Chat"),
                  tabs
                    .tab({
                      element: h.button.class(TabsTabClass).attr("data-testid", "mode-split-btn"),
                      value: "split",
                    })
                    .children(IconColumns(h), "Split"),
                  tabs
                    .tab({
                      element: h.button.class(TabsTabClass).attr("data-testid", "mode-stage-btn"),
                      value: "stage",
                    })
                    .children(IconPanelRight(h), "Stage"),
                ),
              ),
          }),
        ),
        FramePanel(h).children(
          h.div
            .attrs({ role: "log", "aria-label": "Project conversation", "data-testid": "chat-stream" })
            .class("min-h-0 flex-1 overflow-y-auto")
            .children(
              h.div.class("flex flex-col gap-3 px-4 py-3.5").children(
                timeline.map((entry) => {
                  const blocks = parseVibestMessageBlocks(entry.content)
                  const isOwn = entry.role === "user"

                  return h.div
                    .key(entry.id)
                    .attr("data-testid", `chat-turn-${entry.id}`)
                    .class("flex w-full items-start gap-2.5", isOwn && "flex-row-reverse")
                    .children(
                      h.div
                        .class(
                          "flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                          isOwn ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                        )
                        .children(initialsOf(entry.senderLabel)),
                      h.div
                        .class(
                          "flex min-w-0 flex-1 flex-col gap-2 rounded-xl border border-border px-3.5 py-2.5 shadow-xs/5",
                          isOwn ? "bg-accent/70" : "bg-card",
                        )
                        .children(
                          h.div
                            .class("flex items-center gap-2")
                            .children(
                              h.span.class("text-xs font-semibold text-foreground").children(entry.senderLabel),
                              h.span
                                .class("font-mono text-[10.5px] text-muted-foreground tabular-nums")
                                .children(formatTime(entry.createdAt)),
                              entry.status === "working" && Badge(h, "info").children("Working"),
                              entry.status === "blocked" && Badge(h, "warning").children("Needs You"),
                            ),
                          entry.attachments.length > 0 &&
                            h.div
                              .class("flex flex-wrap gap-1.5")
                              .children(
                                entry.attachments.map((att) =>
                                  Badge(h, "info", "gap-1 font-mono text-[10.5px]")
                                    .key(att)
                                    .children(IconFileText(h, "size-2.5"), `@${att}`),
                                ),
                              ),
                          h.div.class("flex flex-col gap-2 text-[13px] text-foreground").children(
                            blocks.map((block, idx) => {
                              if (block.kind === "agent-report") {
                                const reportKey = `${entry.id}-rep-${idx}`
                                const expanded = model.expandedReports[reportKey] === true
                                const repSession = sessionById.get(block.agentId)

                                return Collapsible(h, {
                                  key: reportKey,
                                  props: { open: expanded },
                                  onEmit: {
                                    Toggled: () => ChatPanelMessage.ToggledAgentReport({ reportKey }),
                                    Settled: () => undefined,
                                  },
                                  view: (collapsible) =>
                                    collapsible
                                      .root(
                                        h.div
                                          .attr("data-testid", `agent-report-card-${block.agentId.slice(0, 8)}`)
                                          .class("overflow-hidden rounded-xl border border-border bg-card shadow-xs/5"),
                                      )
                                      .children(
                                        h.div
                                          .class(
                                            "flex flex-wrap items-center justify-between gap-2 border-b border-border/80 bg-muted/35 px-2.5 py-1.5",
                                          )
                                          .children(
                                            collapsible
                                              .trigger(
                                                h.button
                                                  .attr("type", "button")
                                                  .class("flex min-w-0 cursor-pointer items-center gap-1.5 text-left"),
                                              )
                                              .children(
                                                expanded
                                                  ? IconChevronDown(h, "size-3.5 shrink-0 text-muted-foreground")
                                                  : IconChevronRight(h, "size-3.5 shrink-0 text-muted-foreground"),
                                                IconBot(h, "size-3.5 shrink-0 text-info-foreground"),
                                                h.span
                                                  .class("truncate text-xs font-semibold text-foreground")
                                                  .children(repSession?.name ?? `agent-${block.agentId.slice(0, 8)}`),
                                                h.span
                                                  .class("font-mono text-[10.5px] text-muted-foreground tabular-nums")
                                                  .children(
                                                    block.machine !== null
                                                      ? `${block.agentId.slice(0, 8)} · ${block.machine}`
                                                      : block.agentId.slice(0, 8),
                                                  ),
                                                repSession?.git?.branch
                                                  ? Badge(
                                                      h,
                                                      "outline",
                                                      "max-w-44 gap-1 truncate font-mono text-[10px]",
                                                    ).children(
                                                      IconGitBranch(h),
                                                      h.span.class("truncate").children(repSession.git.branch),
                                                    )
                                                  : false,
                                              ),
                                            h.div.class("flex shrink-0 items-center gap-1").children(
                                              h.button
                                                .attr("type", "button")
                                                .class(buttonClass("outline", "xs"))
                                                .on(
                                                  "click",
                                                  ChatPanelMessage.ClickedPeekSession({ sessionId: block.agentId }),
                                                )
                                                .children(IconTerminal(h), "Peek Terminal"),
                                              h.button
                                                .attr("type", "button")
                                                .class(buttonClass("ghost", "xs"))
                                                .on(
                                                  "click",
                                                  ChatPanelMessage.ClickedFocusSession({ sessionId: block.agentId }),
                                                )
                                                .children("Open Branch"),
                                            ),
                                          ),
                                        h.div
                                          .class("px-3 py-2 text-[12.5px] font-medium text-foreground")
                                          .children(block.firstLine),
                                        block.details.length > 0 &&
                                          collapsible
                                            .panel(
                                              h.div.class(
                                                "border-t border-border/70 px-3 py-2 text-xs text-muted-foreground",
                                              ),
                                            )
                                            ?.children(
                                              h.div
                                                .class("markdown-prose")
                                                .onMount(
                                                  RenderSafeHtml({ html: renderSafeMarkdownHtml(block.details) }),
                                                ),
                                            ),
                                      ),
                                })
                              }

                              if (block.kind === "system-notice") {
                                return h.div
                                  .key(`${entry.id}-sys-${idx}`)
                                  .class(
                                    "flex items-center gap-2 rounded-lg border border-info/25 bg-info/10 px-2.5 py-1.5 text-xs text-foreground",
                                  )
                                  .children(
                                    IconSparkles(h, "size-3.5 shrink-0 text-info-foreground"),
                                    h.span.children(block.body),
                                  )
                              }

                              return h.div
                                .key(`${entry.id}-txt-${idx}`)
                                .class("markdown-prose")
                                .onMount(RenderSafeHtml({ html: renderSafeMarkdownHtml(block.text) }))
                            }),
                          ),
                        ),
                    )
                }),
                timeline.length === 0 &&
                  EmptyState(
                    h,
                    `Ready to orchestrate ${project?.name ?? "project"}`,
                    "Send a prompt below or open an artifact from the right panel.",
                  ),
              ),
            ),
          h.div
            .attr("data-testid", "composer-dock")
            .class("shrink-0 border-t border-border/70 bg-muted/20 p-2.5")
            .children(
              h.form
                .class("flex flex-col overflow-hidden rounded-xl border border-input bg-background shadow-xs/5")
                .on("submit", ChatPanelMessage.SubmittedComposer())
                .children(
                  attachedPaths.length > 0 &&
                    h.div
                      .attr("data-testid", "composer-chips")
                      .class("flex flex-wrap gap-1.5 px-2.5 pt-2")
                      .children(
                        attachedPaths.map((rel) =>
                          Badge(h, "info", "gap-1 pr-1 font-mono text-[10.5px]")
                            .key(rel)
                            .children(
                              IconFileText(h, "size-2.5"),
                              h.span.children(`@${rel}`),
                              h.button
                                .attrs({ type: "button", "aria-label": `Remove ${rel}` })
                                .class("inline-flex cursor-pointer rounded hover:bg-info/20")
                                .on("click", ChatPanelMessage.ClickedRemoveAttachment({ relativePath: rel }))
                                .children(IconX(h, "size-2.5")),
                            ),
                        ),
                      ),
                  h.textarea
                    .attrs({
                      "data-testid": "composer-textarea",
                      placeholder:
                        "Message session or type @ to attach project artifacts, docs, or memories... (Enter to send)",
                      "aria-label": "Message session",
                      rows: "2",
                    })
                    .class(
                      "w-full resize-none bg-transparent px-3 py-2 text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground",
                    )
                    .value(composerText)
                    .onMount(SyncTextareaHeight({ text: composerText }))
                    .on("input", ({ value }) => ChatPanelMessage.UpdatedComposerText({ text: value }))
                    .on(
                      "keydown",
                      ({ key, shift, composing }) =>
                        key === "Enter" && !shift && !composing ? ChatPanelMessage.SubmittedComposer() : undefined,
                      { preventDefault: true },
                    ),
                  h.div.class("flex items-center justify-between gap-2 border-t border-border/60 px-2 py-1.5").children(
                    h.div.class("flex items-center gap-1.5").children(
                      Popover(h, {
                        props: { open: model.atOpen, side: "top", align: "start", sideOffset: 6 },
                        onEmit: {
                          RequestedOpen: () => ChatPanelMessage.RequestedOpenAtPopover(),
                          RequestedClose: () => ChatPanelMessage.RequestedCloseAtPopover(),
                          Settled: () => undefined,
                        },
                        view: (popover) =>
                          h.div.class("relative inline-flex").children(
                            popover
                              .trigger({
                                element: h.button
                                  .attrs({ type: "button", "data-testid": "composer-at-btn" })
                                  .class(buttonClass("outline", "xs")),
                              })
                              .children(IconAtSign(h), "Context"),
                            popover.portal(h.dialog)?.children(
                              popover.positioner(h.div).children(
                                popover
                                  .popup(
                                    h.div
                                      .attr("data-testid", "at-picker-popover")
                                      .class(
                                        "w-80 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg",
                                      ),
                                  )
                                  .children(
                                    h.div.class("flex flex-col gap-2").children(
                                      h.input
                                        .attrs({
                                          type: "text",
                                          placeholder: "Attach artifact, doc, or memory...",
                                          "aria-label": "Filter context files",
                                        })
                                        .class(
                                          "h-7 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/40",
                                        )
                                        .value(model.atFilter)
                                        .on("input", ({ value }) =>
                                          ChatPanelMessage.UpdatedAtFilter({ filter: value }),
                                        ),
                                      h.div.class("flex max-h-48 flex-col gap-0.5 overflow-y-auto").children(
                                        filteredFiles.slice(0, 10).map((file) =>
                                          h.button
                                            .key(file.id)
                                            .attrs({ type: "button", "data-testid": `at-pick-${file.name}` })
                                            .class(
                                              "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                                            )
                                            .on(
                                              "click",
                                              ChatPanelMessage.PickedAttachment({ relativePath: file.relativePath }),
                                            )
                                            .children(
                                              IconFileText(h, "size-3 shrink-0 text-muted-foreground"),
                                              h.span
                                                .class("min-w-0 flex-1 truncate font-mono text-[11px]")
                                                .children(file.relativePath),
                                              Badge(h, "outline").children(file.category),
                                            ),
                                        ),
                                        filteredFiles.length === 0 &&
                                          h.div
                                            .class("py-4 text-center text-xs text-muted-foreground")
                                            .children("No matching files"),
                                      ),
                                    ),
                                  ),
                              ),
                            ),
                          ),
                      }),
                      Select(h, {
                        props: {
                          open: model.targetSelectOpen,
                          value: targetSessionId,
                          items: selectItems,
                          alignItemWithTrigger: false,
                          side: "top",
                          align: "start",
                        },
                        onEmit: {
                          RequestedOpen: () => ChatPanelMessage.RequestedOpenTargetSelect(),
                          RequestedClose: () => ChatPanelMessage.RequestedCloseTargetSelect(),
                          Picked: ({ value }) =>
                            Predicate.isString(value)
                              ? ChatPanelMessage.PickedTargetSession({ sessionId: value })
                              : undefined,
                          Settled: () => undefined,
                        },
                        view: (select) =>
                          h.div.class("relative inline-flex").children(
                            select
                              .trigger(
                                h.button
                                  .attrs({
                                    type: "button",
                                    "data-testid": "composer-target-select",
                                    "aria-label": "Target session",
                                  })
                                  .class(buttonClass("outline", "xs", "max-w-52 justify-between gap-1.5 font-normal")),
                              )
                              .children(
                                select
                                  .value(h.span.class("truncate"))
                                  .children(
                                    targetSession !== undefined
                                      ? targetSession.isEntry
                                        ? `Entry · ${targetSession.name}`
                                        : `${targetSession.name} (${targetSession.git?.branch || targetSession.harness})`
                                      : "Select session",
                                  ),
                                select
                                  .icon(h.span.class("text-muted-foreground"))
                                  .children(IconChevronDown(h, "size-3")),
                              ),
                            select.positioner(h.div.class("z-50 border-0 bg-transparent p-0")).children(
                              select
                                .popup(
                                  h.div.class(
                                    "min-w-52 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg",
                                  ),
                                )
                                .children(
                                  selectItems.map((item) =>
                                    select
                                      .item({
                                        element: h.div.class(
                                          "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-accent data-[selected]:font-medium",
                                        ),
                                        value: item.value,
                                      })
                                      .children(select.itemText(h.div.class("truncate")).children(item.label)),
                                  ),
                                ),
                            ),
                          ),
                      }),
                    ),
                    h.button
                      .attrs({ type: "submit", "data-testid": "composer-send-btn" })
                      .class(buttonClass("default", "xs"))
                      .disabled(sending || composerText.trim().length === 0 || targetSessionId === null)
                      .children(IconSend(h), sending ? "Sending..." : "Send"),
                  ),
                ),
            ),
        ),
      )
  },
})
