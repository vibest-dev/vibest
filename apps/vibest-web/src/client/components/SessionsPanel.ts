import { UiSchema } from "@effect/ui"
import { Collapsible, Tabs } from "@effect/ui-kit"
import { Html } from "@effect/ui/html"
import { Match, Schema } from "effect"

import {
  SessionFilterSchema,
  SessionItemSchema,
  ThemeModeSchema,
  type SessionFilter,
  type SessionItem,
} from "../../domain/WebHub.ts"
import {
  IconArchive,
  IconChevronDown,
  IconChevronRight,
  IconCloudUpload,
  IconGitBranch,
  IconLayers,
  IconSend,
  IconSquare,
  IconTerminal,
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
  type BadgeVariant,
} from "../ui/primitives.ts"
import { WtermView } from "./WtermView.ts"

function formatElapsed(createdAt: number, lastActive: number): string {
  const diffSec = Math.max(1, Math.floor((Date.now() - Math.min(createdAt, lastActive)) / 1000))

  if (diffSec < 60) return `${diffSec}s`
  const mins = Math.floor(diffSec / 60)

  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)

  return `${hrs}h ${mins % 60}m`
}

function statusDotClass(session: SessionItem): string {
  if (session.needsYou) return "bg-warning shadow-[0_0_0_2px_color-mix(in_srgb,var(--warning)_24%,transparent)]"

  if (session.status === "working")
    return "bg-info shadow-[0_0_0_2px_color-mix(in_srgb,var(--info)_24%,transparent)] animate-pulse"

  if (session.status === "done") return "bg-success"

  return "bg-muted-foreground/50"
}

function statusBadgeVariant(session: SessionItem): BadgeVariant {
  if (session.needsYou) return "warning"

  if (session.status === "working") return "info"

  if (session.status === "done") return "success"

  return "secondary"
}

function statusLabel(session: SessionItem): string {
  if (session.needsYou) return "Needs You"

  if (session.status === "working") return "Working"

  if (session.status === "done") return "Done"

  return "Idle"
}

const isSessionFilter = Schema.is(SessionFilterSchema)

function toSessionFilter(value: string): SessionFilter {
  return isSessionFilter(value) ? value : "all"
}

export const SessionsPanelMessage = UiSchema.TaggedEnum({
  SelectedFilter: { filter: SessionFilterSchema },
  ToggledPeek: { sessionId: Schema.String },
  ClickedRefreshPeek: { sessionId: Schema.String },
  ClickedExpandTerminal: { sessionId: Schema.String },
  ClickedSelectForSend: { sessionId: Schema.String },
  ClickedInterrupt: { sessionId: Schema.String },
  ClickedArchive: { sessionId: Schema.String },
})

export const SessionsPanelEvents = UiSchema.TaggedEnum({
  ToggledPeek: { sessionId: Schema.String },
  RequestedRefreshPeek: { sessionId: Schema.String },
  RequestedOpenTerminalStage: { sessionId: Schema.String },
  SelectedForSend: { sessionId: Schema.String },
  RequestedInterrupt: { sessionId: Schema.String },
  RequestedArchive: { sessionId: Schema.String },
})

const SessionsPanelDef = Html.component({
  name: "SessionsPanel",
  props: Schema.Struct({
    sessions: Schema.Array(SessionItemSchema),
    theme: ThemeModeSchema,
    expandedPeekId: Schema.NullOr(Schema.String),
    peekCache: Schema.Record(Schema.String, Schema.String),
  }),
  model: Schema.Struct({
    filter: SessionFilterSchema,
  }),
  message: SessionsPanelMessage,
  events: SessionsPanelEvents,
})

export const SessionsPanel = SessionsPanelDef.make({
  init: () => ({ filter: "all" }),
  update: {
    SelectedFilter: ($, { filter }) => $.evolve({ filter }),
    ToggledPeek: ($, { sessionId }) => $.emit(SessionsPanelEvents.ToggledPeek({ sessionId })),
    ClickedRefreshPeek: ($, { sessionId }) => $.emit(SessionsPanelEvents.RequestedRefreshPeek({ sessionId })),
    ClickedExpandTerminal: ($, { sessionId }) => $.emit(SessionsPanelEvents.RequestedOpenTerminalStage({ sessionId })),
    ClickedSelectForSend: ($, { sessionId }) => $.emit(SessionsPanelEvents.SelectedForSend({ sessionId })),
    ClickedInterrupt: ($, { sessionId }) => $.emit(SessionsPanelEvents.RequestedInterrupt({ sessionId })),
    ClickedArchive: ($, { sessionId }) => $.emit(SessionsPanelEvents.RequestedArchive({ sessionId })),
  },
  view: (h, model) => {
    const { sessions, theme, expandedPeekId, peekCache } = h.props
    const branchSessions = sessions.filter((s) => !s.isEntry)

    let needsYou = 0
    let working = 0
    let done = 0

    for (const s of branchSessions) {
      if (s.needsYou) needsYou += 1
      else if (s.status === "working") working += 1
      else done += 1
    }

    const filtered = Match.value(model.filter).pipe(
      Match.when("all", () => branchSessions),
      Match.when("needs_you", () => branchSessions.filter((s) => s.needsYou)),
      Match.when("working", () => branchSessions.filter((s) => !s.needsYou && s.status === "working")),
      Match.when("done", () => branchSessions.filter((s) => !s.needsYou && s.status !== "working")),
      Match.exhaustive,
    )

    return Frame(h)
      .attr("data-testid", "sessions-panel")
      .children(
        FrameHeader(h, "py-2").children(
          h.div
            .class("flex items-center gap-1.5")
            .children(
              IconLayers(h, "size-3.5 shrink-0 text-muted-foreground"),
              FrameTitle(h).children("Sessions"),
              Badge(h, "outline", "tabular-nums").children(String(branchSessions.length)),
            ),
          Badge(h, "info", "gap-1.5")
            .attr("title", "Live via vibestd Watch SSE")
            .children(h.span.class("size-1.5 animate-pulse rounded-full bg-info"), "Watch"),
        ),
        FramePanel(h).children(
          h.div.class("border-b border-border px-2.5 py-1.5").children(
            Tabs(h, {
              props: {
                value: model.filter,
                tabs: [{ value: "all" }, { value: "needs_you" }, { value: "working" }, { value: "done" }],
              },
              onEmit: {
                Selected: ({ value }) => SessionsPanelMessage.SelectedFilter({ filter: toSessionFilter(value) }),
              },
              view: (tabs) =>
                tabs.root(h.div).children(
                  tabs.list(h.div.class(`${TabsListClass} w-full`)).children(
                    tabs
                      .tab({
                        element: h.button.class(`${TabsTabClass} flex-1`).attr("data-testid", "sessions-filter-all"),
                        value: "all",
                      })
                      .children("All", h.span.class("tabular-nums opacity-70").children(String(branchSessions.length))),
                    tabs
                      .tab({
                        element: h.button
                          .class(`${TabsTabClass} flex-1`)
                          .attr("data-testid", "sessions-filter-needs-you"),
                        value: "needs_you",
                      })
                      .children("Needs You", h.span.class("tabular-nums opacity-70").children(String(needsYou))),
                    tabs
                      .tab({
                        element: h.button
                          .class(`${TabsTabClass} flex-1`)
                          .attr("data-testid", "sessions-filter-working"),
                        value: "working",
                      })
                      .children("Working", h.span.class("tabular-nums opacity-70").children(String(working))),
                    tabs
                      .tab({
                        element: h.button.class(`${TabsTabClass} flex-1`).attr("data-testid", "sessions-filter-done"),
                        value: "done",
                      })
                      .children("Done", h.span.class("tabular-nums opacity-70").children(String(done))),
                  ),
                ),
            }),
          ),
          h.div.class("min-h-0 flex-1 overflow-y-auto").children(
            h.div.class("flex flex-col gap-2 p-2").children(
              filtered.map((session) => {
                const isExpanded = expandedPeekId === session.id
                const shortId = session.id.slice(0, 8)

                return Collapsible(h, {
                  key: session.id,
                  props: { open: isExpanded },
                  onEmit: {
                    Toggled: () => SessionsPanelMessage.ToggledPeek({ sessionId: session.id }),
                    Settled: () => undefined,
                  },
                  view: (collapsible) =>
                    collapsible
                      .root(
                        h.div
                          .attr("data-testid", `session-card-${shortId}`)
                          .class(
                            "overflow-hidden rounded-xl border bg-background/80 transition-colors",
                            isExpanded ? "border-ring/50 shadow-xs" : "border-border",
                          ),
                      )
                      .children(
                        collapsible
                          .trigger(
                            h.button
                              .attr("type", "button")
                              .class(
                                "flex w-full cursor-pointer flex-col gap-1.5 px-2.5 pt-2.5 pb-2 text-left transition-colors hover:bg-accent/50",
                              ),
                          )
                          .children(
                            h.div
                              .class("flex items-center gap-1.5")
                              .children(
                                isExpanded
                                  ? IconChevronDown(h, "size-3.5 shrink-0 text-muted-foreground")
                                  : IconChevronRight(h, "size-3.5 shrink-0 text-muted-foreground"),
                                h.span.class("size-2 shrink-0 rounded-full", statusDotClass(session)),
                                h.span
                                  .class("min-w-0 flex-1 truncate text-xs font-semibold text-foreground")
                                  .children(session.name),
                                h.span
                                  .class("font-mono text-[10.5px] text-muted-foreground tabular-nums")
                                  .children(formatElapsed(session.createdAt, session.lastActive)),
                              ),
                            h.div
                              .class("flex flex-wrap items-center gap-1")
                              .children(
                                Badge(h, statusBadgeVariant(session)).children(statusLabel(session)),
                                session.git !== null &&
                                  session.git.branch.length > 0 &&
                                  Badge(h, "outline", "max-w-44 gap-1 truncate font-mono text-[10px]").children(
                                    IconGitBranch(h),
                                    h.span.class("truncate").children(session.git.branch),
                                  ),
                                session.git?.pushed
                                  ? Badge(h, "success", "gap-1").children(IconCloudUpload(h), "pushed")
                                  : session.git?.saved
                                    ? Badge(h, "secondary").children("saved")
                                    : false,
                                Badge(h, "outline", "font-mono text-[10px] text-muted-foreground").children(
                                  `${session.harness}${session.model ? `/${session.model}` : ""}`,
                                ),
                              ),
                            session.summary.length > 0 &&
                              h.p
                                .class("line-clamp-2 text-[11.5px] leading-snug text-muted-foreground")
                                .children(session.summary),
                          ),
                        h.div
                          .class("flex items-center gap-1 border-t border-border/70 bg-muted/25 px-2 py-1.5")
                          .children(
                            h.button
                              .attrs({
                                type: "button",
                                "data-testid": `session-peek-btn-${shortId}`,
                                title: "Toggle live @wterm/dom terminal peek",
                              })
                              .class(buttonClass("outline", "xs"))
                              .on("click", SessionsPanelMessage.ToggledPeek({ sessionId: session.id }))
                              .children(IconTerminal(h), "Peek"),
                            h.button
                              .attrs({ type: "button", "data-testid": `session-send-btn-${shortId}` })
                              .class(buttonClass("ghost", "xs"))
                              .on("click", SessionsPanelMessage.ClickedSelectForSend({ sessionId: session.id }))
                              .children(IconSend(h), "Send"),
                            h.button
                              .attrs({ type: "button", "data-testid": `session-interrupt-btn-${shortId}` })
                              .class(buttonClass("ghost", "xs"))
                              .on("click", SessionsPanelMessage.ClickedInterrupt({ sessionId: session.id }))
                              .children(IconSquare(h), "Interrupt"),
                            h.button
                              .attrs({ type: "button", "data-testid": `session-archive-btn-${shortId}` })
                              .class(
                                buttonClass(
                                  "ghost",
                                  "xs",
                                  "ml-auto text-muted-foreground hover:text-destructive-foreground",
                                ),
                              )
                              .on("click", SessionsPanelMessage.ClickedArchive({ sessionId: session.id }))
                              .children(IconArchive(h), "Archive"),
                          ),
                        collapsible.panel(h.div.class("border-t border-border/70 bg-muted/20 p-1.5"))?.children(
                          WtermView(h, {
                            key: `peek-${session.id}`,
                            props: {
                              content: peekCache[session.id] ?? "Connecting to terminal stream...",
                              theme,
                              compact: true,
                              title: `@wterm/dom · ${session.git?.branch || session.name}`,
                              canExpand: true,
                            },
                            onEmit: {
                              RequestedRefresh: () =>
                                SessionsPanelMessage.ClickedRefreshPeek({ sessionId: session.id }),
                              RequestedExpand: () =>
                                SessionsPanelMessage.ClickedExpandTerminal({ sessionId: session.id }),
                            },
                          }),
                        ),
                      ),
                })
              }),
              filtered.length === 0 && EmptyState(h, "No branch sessions", "No subagents match this filter."),
            ),
          ),
        ),
      )
  },
})
