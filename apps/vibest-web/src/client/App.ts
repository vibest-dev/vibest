import { Command, Component, Subscription, UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Effect, Layer, Schema, Stream } from "effect"

import {
  DaemonStatusSchema,
  INITIAL_DAEMON,
  ProjectFileEntrySchema,
  ProjectSummarySchema,
  SessionItemSchema,
  StageItemSchema,
  StageModeSchema,
  StreamPayloadSchema,
  ThemeModeSchema,
  TimelineEntrySchema,
  WorkspaceSnapshotSchema,
  type ProjectSummary,
  type SessionItem,
  type StageItem,
} from "../domain/WebHub.ts"
import { ChatPanel } from "./components/ChatPanel.ts"
import { KnowledgePanel } from "./components/KnowledgePanel.ts"
import { ProjectsPanel } from "./components/ProjectsPanel.ts"
import { SessionsPanel } from "./components/SessionsPanel.ts"
import { StagePanel } from "./components/StagePanel.ts"
import { SyncThemeClass } from "./mounts/DomMounts.ts"
import { VibestWebApi, VibestWebApiBrowserLayer } from "./services/VibestWebApi.ts"

export const AppMessage = UiSchema.TaggedEnum({
  SucceededLoadState: { snapshot: WorkspaceSnapshotSchema },
  FailedLoadState: {},
  ReceivedStreamEvent: { payload: StreamPayloadSchema },
  SucceededLoadTimeline: { sessionId: Schema.String, entries: Schema.Array(TimelineEntrySchema) },
  FailedLoadTimeline: { sessionId: Schema.String },
  SucceededPeekSession: { sessionId: Schema.String, terminal: Schema.String },
  FailedPeekSession: { sessionId: Schema.String },
  SucceededSend: { ok: Schema.Boolean, error: Schema.NullOr(Schema.String) },
  FailedSend: { reason: Schema.String },
  CompletedSessionAction: { message: Schema.String },
  DismissedToast: { message: Schema.String },
  SelectedProject: { projectId: Schema.String },
  ToggledTheme: {},
  RequestedStageMode: { mode: StageModeSchema },
  RequestedTargetSession: { sessionId: Schema.String },
  RequestedComposerText: { text: Schema.String },
  RequestedAddAttachment: { relativePath: Schema.String },
  RequestedRemoveAttachment: { relativePath: Schema.String },
  RequestedSend: {},
  ToggledPeek: { sessionId: Schema.String },
  RequestedRefreshPeek: { sessionId: Schema.String },
  RequestedOpenTerminalStage: { sessionId: Schema.String },
  RequestedFocusSession: { sessionId: Schema.String },
  SelectedForSend: { sessionId: Schema.String },
  RequestedInterrupt: { sessionId: Schema.String },
  RequestedArchive: { sessionId: Schema.String },
  OpenedFile: { file: ProjectFileEntrySchema },
  AttachedFile: { relativePath: Schema.String },
  AddedToComposer: { text: Schema.String, attachmentPath: Schema.NullOr(Schema.String) },
  ClosedStage: {},
})

export class LoadWorkspaceState extends Command.Service<LoadWorkspaceState>()("vibest-web/LoadWorkspaceState", {
  success: AppMessage,
  mode: "switch",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* VibestWebApi

      return () =>
        api.getState().pipe(
          Effect.match({
            onSuccess: (snapshot) => AppMessage.SucceededLoadState({ snapshot }),
            onFailure: () => AppMessage.FailedLoadState(),
          }),
        )
    }),
  )
}

export class LoadTimeline extends Command.Service<LoadTimeline>()("vibest-web/LoadTimeline", {
  args: { projectId: Schema.String, sessionId: Schema.String },
  success: AppMessage,
  mode: "switch",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* VibestWebApi

      return ({ projectId, sessionId }) =>
        api.getTimeline(projectId, sessionId).pipe(
          Effect.match({
            onSuccess: (entries) => AppMessage.SucceededLoadTimeline({ sessionId, entries }),
            onFailure: () => AppMessage.FailedLoadTimeline({ sessionId }),
          }),
        )
    }),
  )
}

export class PeekSession extends Command.Service<PeekSession>()("vibest-web/PeekSession", {
  args: { sessionId: Schema.String },
  success: AppMessage,
  mode: "concurrent",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* VibestWebApi

      return ({ sessionId }) =>
        api.peekSession(sessionId).pipe(
          Effect.match({
            onSuccess: (res) => AppMessage.SucceededPeekSession({ sessionId, terminal: res.terminal || res.text }),
            onFailure: () => AppMessage.FailedPeekSession({ sessionId }),
          }),
        )
    }),
  )
}

export class SendSessionMessage extends Command.Service<SendSessionMessage>()("vibest-web/SendSessionMessage", {
  args: {
    sessionId: Schema.String,
    message: Schema.String,
    attachments: Schema.Array(Schema.String),
  },
  success: AppMessage,
  mode: "queue",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* VibestWebApi

      return ({ sessionId, message, attachments }) =>
        api.sendToSession(sessionId, message, attachments).pipe(
          Effect.match({
            onSuccess: (res) => AppMessage.SucceededSend({ ok: res.ok, error: res.error }),
            onFailure: (err) => AppMessage.FailedSend({ reason: err.message }),
          }),
        )
    }),
  )
}

export class InterruptSession extends Command.Service<InterruptSession>()("vibest-web/InterruptSession", {
  args: { sessionId: Schema.String },
  success: AppMessage,
  mode: "concurrent",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* VibestWebApi

      return ({ sessionId }) =>
        api.interruptSession(sessionId).pipe(
          Effect.match({
            onSuccess: (res) => AppMessage.CompletedSessionAction({ message: res.message }),
            onFailure: (err) => AppMessage.CompletedSessionAction({ message: err.message }),
          }),
        )
    }),
  )
}

export class ArchiveSession extends Command.Service<ArchiveSession>()("vibest-web/ArchiveSession", {
  args: { sessionId: Schema.String },
  success: AppMessage,
  mode: "concurrent",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* VibestWebApi

      return ({ sessionId }) =>
        api.archiveSession(sessionId).pipe(
          Effect.match({
            onSuccess: (res) => AppMessage.CompletedSessionAction({ message: res.message }),
            onFailure: (err) => AppMessage.CompletedSessionAction({ message: err.message }),
          }),
        )
    }),
  )
}

const WaitToastDismissal = Command.make(
  "WaitToastDismissal",
  { args: { message: Schema.String }, mode: "switch" },
  ({ message }) => Effect.sleep("2800 millis").pipe(Effect.as(AppMessage.DismissedToast({ message }))),
)

const AppDef = Html.component({
  name: "VibestWebApp",
  model: Schema.Struct({
    theme: ThemeModeSchema,
    daemon: DaemonStatusSchema,
    projects: Schema.Array(ProjectSummarySchema),
    sessions: Schema.Array(SessionItemSchema),
    filesByProject: Schema.Record(Schema.String, Schema.Array(ProjectFileEntrySchema)),
    selectedProjectId: Schema.NullOr(Schema.String),
    activeSessionId: Schema.NullOr(Schema.String),
    targetSessionId: Schema.NullOr(Schema.String),
    timeline: Schema.Array(TimelineEntrySchema),
    stageMode: StageModeSchema,
    stageItem: Schema.NullOr(StageItemSchema),
    expandedPeekId: Schema.NullOr(Schema.String),
    peekCache: Schema.Record(Schema.String, Schema.String),
    composerText: Schema.String,
    attachedPaths: Schema.Array(Schema.String),
    sending: Schema.Boolean,
    toast: Schema.NullOr(Schema.String),
  }),
  message: AppMessage,
})

function resolveProjectSessions(
  projects: ReadonlyArray<ProjectSummary>,
  sessions: ReadonlyArray<SessionItem>,
  selectedProjectId: string | null,
  prevActive: string | null,
  prevTarget: string | null,
) {
  const projectId =
    selectedProjectId !== null && projects.some((p) => p.id === selectedProjectId)
      ? selectedProjectId
      : (projects[0]?.id ?? null)

  const project = projects.find((p) => p.id === projectId) ?? null
  const projectSessions = projectId !== null ? sessions.filter((s) => s.projectId === projectId) : []

  if (project === null) {
    return { projectId: null, activeSessionId: null, targetSessionId: null }
  }

  const entryId = project.entrySessionId ?? projectSessions.find((s) => s.isEntry)?.id ?? projectSessions[0]?.id ?? null

  const activeSessionId = prevActive !== null && projectSessions.some((s) => s.id === prevActive) ? prevActive : entryId

  const targetSessionId = prevTarget !== null && projectSessions.some((s) => s.id === prevTarget) ? prevTarget : entryId

  return { projectId, activeSessionId, targetSessionId }
}

function stageKeyFor(item: StageItem): string {
  return item.kind === "file" ? `file:${item.file.id}:${item.file.updatedAt}` : `term:${item.sessionId}`
}

export const AppNoDeps = AppDef.make({
  init: ($) =>
    $.set({
      theme: "dark",
      daemon: INITIAL_DAEMON,
      projects: [],
      sessions: [],
      filesByProject: {},
      selectedProjectId: null,
      activeSessionId: null,
      targetSessionId: null,
      timeline: [],
      stageMode: "chat",
      stageItem: null,
      expandedPeekId: null,
      peekCache: {},
      composerText: "",
      attachedPaths: [],
      sending: false,
      toast: null,
    }).run(LoadWorkspaceState.make()),
  update: {
    SucceededLoadState: ($, { snapshot }) => {
      const resolved = resolveProjectSessions(
        snapshot.projects,
        snapshot.sessions,
        $.model.selectedProjectId,
        $.model.activeSessionId,
        $.model.targetSessionId,
      )

      const step = $.evolve({
        daemon: snapshot.daemon,
        projects: snapshot.projects,
        sessions: snapshot.sessions,
        filesByProject: snapshot.filesByProject,
        selectedProjectId: resolved.projectId,
        activeSessionId: resolved.activeSessionId,
        targetSessionId: resolved.targetSessionId,
      })

      if (resolved.projectId !== null && resolved.activeSessionId !== null) {
        return step.run(LoadTimeline.make({ projectId: resolved.projectId, sessionId: resolved.activeSessionId }))
      }

      return step
    },
    FailedLoadState: ($) => $.model,
    ReceivedStreamEvent: ($, { payload }) => {
      switch (payload.type) {
        case "snapshot": {
          const snap = payload.data

          const resolved = resolveProjectSessions(
            snap.projects,
            snap.sessions,
            $.model.selectedProjectId,
            $.model.activeSessionId,
            $.model.targetSessionId,
          )

          const step = $.evolve({
            daemon: snap.daemon,
            projects: snap.projects,
            sessions: snap.sessions,
            filesByProject: snap.filesByProject,
            selectedProjectId: resolved.projectId,
            activeSessionId: resolved.activeSessionId,
            targetSessionId: resolved.targetSessionId,
          })

          if (
            resolved.projectId !== null &&
            resolved.activeSessionId !== null &&
            resolved.activeSessionId !== $.model.activeSessionId
          ) {
            return step.run(LoadTimeline.make({ projectId: resolved.projectId, sessionId: resolved.activeSessionId }))
          }

          return step
        }

        case "daemon":
          return $.evolve({ daemon: payload.data })

        case "project": {
          const updated = payload.data
          const exists = $.model.projects.some((p) => p.id === updated.id)

          const nextProjects = exists
            ? $.model.projects.map((p) => (p.id === updated.id ? updated : p))
            : [...$.model.projects, updated]

          return $.evolve({ projects: nextProjects })
        }

        case "session": {
          const updated = payload.data
          const exists = $.model.sessions.some((s) => s.id === updated.id)

          const nextSessions = exists
            ? $.model.sessions.map((s) => (s.id === updated.id ? updated : s))
            : [updated, ...$.model.sessions]

          return $.evolve({ sessions: nextSessions })
        }

        case "session-ended": {
          const nextSessions = $.model.sessions.filter((s) => s.id !== payload.data.id)

          return $.evolve({
            sessions: nextSessions,
            expandedPeekId: $.model.expandedPeekId === payload.data.id ? null : $.model.expandedPeekId,
          })
        }

        case "files-changed": {
          const currentStage = $.model.stageItem

          const updatedFile =
            currentStage?.kind === "file" && currentStage.file.projectId === payload.data.projectId
              ? (payload.data.files.find((f) => f.id === currentStage.file.id) ?? null)
              : null

          return $.evolve({
            filesByProject: (prev) => ({ ...prev, [payload.data.projectId]: payload.data.files }),
            stageItem: updatedFile !== null ? { kind: "file", file: updatedFile } : $.model.stageItem,
          })
        }

        case "timeline-entry": {
          const entry = payload.data

          if (entry.sessionId !== $.model.activeSessionId) return $.model

          if ($.model.timeline.some((t) => t.id === entry.id)) return $.model

          return $.evolve({ timeline: (prev) => [...prev, entry] })
        }
      }
    },
    SucceededLoadTimeline: ($, { sessionId, entries }) =>
      sessionId === $.model.activeSessionId ? $.evolve({ timeline: entries }) : $.model,
    FailedLoadTimeline: ($, { sessionId }) =>
      sessionId === $.model.activeSessionId ? $.evolve({ timeline: [] }) : $.model,
    SucceededPeekSession: ($, { sessionId, terminal }) =>
      $.evolve({ peekCache: (prev) => ({ ...prev, [sessionId]: terminal }) }),
    FailedPeekSession: ($) => $.model,
    SucceededSend: ($, { ok, error }) => {
      const msg = ok ? "Dispatched message via vibestd" : (error ?? "Failed to send")

      const step = $.evolve({
        sending: false,
        composerText: ok ? "" : $.model.composerText,
        attachedPaths: ok ? [] : $.model.attachedPaths,
        toast: msg,
      }).run(WaitToastDismissal.make({ message: msg }))

      if (ok && $.model.selectedProjectId !== null && $.model.activeSessionId !== null) {
        return step.run(LoadTimeline.make({ projectId: $.model.selectedProjectId, sessionId: $.model.activeSessionId }))
      }

      return step
    },
    FailedSend: ($, { reason }) =>
      $.evolve({ sending: false, toast: reason }).run(WaitToastDismissal.make({ message: reason })),
    CompletedSessionAction: ($, { message }) => $.evolve({ toast: message }).run(WaitToastDismissal.make({ message })),
    DismissedToast: ($, { message }) => ($.model.toast === message ? $.evolve({ toast: null }) : $.model),
    SelectedProject: ($, { projectId }) => {
      const resolved = resolveProjectSessions($.model.projects, $.model.sessions, projectId, null, null)

      const step = $.evolve({
        selectedProjectId: resolved.projectId,
        activeSessionId: resolved.activeSessionId,
        targetSessionId: resolved.targetSessionId,
        stageItem: null,
        stageMode: "chat",
        expandedPeekId: null,
        timeline: [],
      })

      if (resolved.projectId !== null && resolved.activeSessionId !== null) {
        return step.run(LoadTimeline.make({ projectId: resolved.projectId, sessionId: resolved.activeSessionId }))
      }

      return step
    },
    ToggledTheme: ($) => $.evolve({ theme: (prev) => (prev === "dark" ? "light" : "dark") }),
    RequestedStageMode: ($, { mode }) => $.evolve({ stageMode: mode }),
    RequestedTargetSession: ($, { sessionId }) => $.evolve({ targetSessionId: sessionId }),
    RequestedComposerText: ($, { text }) => $.evolve({ composerText: text }),
    RequestedAddAttachment: ($, { relativePath }) =>
      $.evolve({
        attachedPaths: (prev) => (prev.includes(relativePath) ? prev : [...prev, relativePath]),
      }),
    RequestedRemoveAttachment: ($, { relativePath }) =>
      $.evolve({ attachedPaths: (prev) => prev.filter((p) => p !== relativePath) }),
    RequestedSend: ($) => {
      if ($.model.targetSessionId === null || $.model.composerText.trim().length === 0 || $.model.sending) {
        return $.model
      }

      return $.evolve({ sending: true }).run(
        SendSessionMessage.make({
          sessionId: $.model.targetSessionId,
          message: $.model.composerText,
          attachments: $.model.attachedPaths,
        }),
      )
    },
    ToggledPeek: ($, { sessionId }) => {
      const next = $.model.expandedPeekId === sessionId ? null : sessionId
      const step = $.evolve({ expandedPeekId: next })

      return next !== null ? step.run(PeekSession.make({ sessionId: next })) : step
    },
    RequestedRefreshPeek: ($, { sessionId }) => $.run(PeekSession.make({ sessionId })),
    RequestedOpenTerminalStage: ($, { sessionId }) =>
      $.evolve({
        stageItem: { kind: "terminal", sessionId },
        stageMode: (prev) => (prev === "chat" ? "split" : prev),
      }).run(PeekSession.make({ sessionId })),
    RequestedFocusSession: ($, { sessionId }) =>
      $.evolve({
        expandedPeekId: sessionId,
        targetSessionId: sessionId,
      }).run(PeekSession.make({ sessionId })),
    SelectedForSend: ($, { sessionId }) => {
      const msg = "Composer target switched to branch session"

      return $.evolve({ targetSessionId: sessionId, toast: msg }).run(WaitToastDismissal.make({ message: msg }))
    },
    RequestedInterrupt: ($, { sessionId }) => $.run(InterruptSession.make({ sessionId })),
    RequestedArchive: ($, { sessionId }) =>
      $.evolve({
        expandedPeekId: $.model.expandedPeekId === sessionId ? null : $.model.expandedPeekId,
      }).run(ArchiveSession.make({ sessionId })),
    OpenedFile: ($, { file }) =>
      $.evolve({
        stageItem: { kind: "file", file },
        stageMode: (prev) => (prev === "chat" ? "split" : prev),
      }),
    AttachedFile: ($, { relativePath }) => {
      const msg = `Attached @${relativePath}`

      return $.evolve({
        attachedPaths: (prev) => (prev.includes(relativePath) ? prev : [...prev, relativePath]),
        toast: msg,
      }).run(WaitToastDismissal.make({ message: msg }))
    },
    AddedToComposer: ($, { text, attachmentPath }) => {
      const msg = "Added structured feedback to Composer"

      return $.evolve({
        composerText: (prev) => (prev.trim().length > 0 ? `${prev.trim()}\n\n${text}` : text),
        attachedPaths: (prev) =>
          attachmentPath !== null && !prev.includes(attachmentPath) ? [...prev, attachmentPath] : prev,
        stageMode: (prev) => (prev === "stage" ? "split" : prev),
        toast: msg,
      }).run(WaitToastDismissal.make({ message: msg }))
    },
    ClosedStage: ($) => $.evolve({ stageItem: null, stageMode: "chat" }),
  },
  subscriptions: () => [
    Subscription.make("web-hub-sse", "live", () =>
      Stream.unwrap(
        Effect.map(VibestWebApi, (api) =>
          api.streamEvents().pipe(Stream.map((payload) => AppMessage.ReceivedStreamEvent({ payload }))),
        ),
      ),
    ),
  ],
  view: (h, model) => {
    const selectedProject = model.projects.find((p) => p.id === model.selectedProjectId) ?? null

    const projectSessions =
      model.selectedProjectId !== null ? model.sessions.filter((s) => s.projectId === model.selectedProjectId) : []

    const projectFiles = model.selectedProjectId !== null ? (model.filesByProject[model.selectedProjectId] ?? []) : []

    const activeStageFileId = model.stageItem?.kind === "file" ? model.stageItem.file.id : null

    const activeStagePeekText =
      model.stageItem?.kind === "terminal" ? (model.peekCache[model.stageItem.sessionId] ?? "Loading terminal...") : ""

    return h.div
      .attr("data-testid", "workspace-canvas")
      .class("flex h-dvh w-full gap-2 overflow-hidden bg-sidebar p-2 text-foreground select-none")
      .onMount(SyncThemeClass({ theme: model.theme }))
      .children(
        h.aside.class("flex h-full w-64 shrink-0 flex-col").children(
          ProjectsPanel(h, {
            props: {
              projects: model.projects,
              selectedProjectId: model.selectedProjectId,
              daemon: model.daemon,
              theme: model.theme,
            },
            onEmit: {
              SelectedProject: ({ projectId }) => AppMessage.SelectedProject({ projectId }),
              ToggledTheme: () => AppMessage.ToggledTheme(),
            },
          }),
        ),
        h.main.class("flex h-full min-w-0 flex-1 gap-2 overflow-hidden select-text").children(
          model.stageMode !== "stage" &&
            h.div.class("flex min-w-0 flex-1 flex-col").children(
              ChatPanel(h, {
                props: {
                  project: selectedProject,
                  sessions: projectSessions,
                  activeSessionId: model.activeSessionId,
                  targetSessionId: model.targetSessionId,
                  timeline: model.timeline,
                  projectFiles,
                  stageMode: model.stageMode,
                  hasStageItem: model.stageItem !== null,
                  composerText: model.composerText,
                  attachedPaths: model.attachedPaths,
                  sending: model.sending,
                },
                onEmit: {
                  RequestedStageMode: ({ mode }) => AppMessage.RequestedStageMode({ mode }),
                  RequestedTargetSession: ({ sessionId }) => AppMessage.RequestedTargetSession({ sessionId }),
                  RequestedComposerText: ({ text }) => AppMessage.RequestedComposerText({ text }),
                  RequestedAddAttachment: ({ relativePath }) => AppMessage.RequestedAddAttachment({ relativePath }),
                  RequestedRemoveAttachment: ({ relativePath }) =>
                    AppMessage.RequestedRemoveAttachment({ relativePath }),
                  RequestedSend: () => AppMessage.RequestedSend(),
                  RequestedPeekSession: ({ sessionId }) => AppMessage.RequestedOpenTerminalStage({ sessionId }),
                  RequestedFocusSession: ({ sessionId }) => AppMessage.RequestedFocusSession({ sessionId }),
                },
              }),
            ),
          model.stageItem !== null &&
            model.stageMode !== "chat" &&
            h.div.class("flex min-w-0 flex-[1.1] flex-col").children(
              StagePanel(h, {
                key: stageKeyFor(model.stageItem),
                props: {
                  item: model.stageItem,
                  theme: model.theme,
                  sessions: projectSessions,
                  peekText: activeStagePeekText,
                },
                onEmit: {
                  RequestedRefreshPeek: ({ sessionId }) => AppMessage.RequestedRefreshPeek({ sessionId }),
                  AddedToComposer: ({ text, attachmentPath }) => AppMessage.AddedToComposer({ text, attachmentPath }),
                  RequestedClose: () => AppMessage.ClosedStage(),
                },
              }),
            ),
        ),
        h.div.class("flex h-full w-[408px] shrink-0 flex-col gap-2 select-text").children(
          h.div.class("flex min-h-36 flex-[1.08] flex-col overflow-hidden").children(
            SessionsPanel(h, {
              props: {
                sessions: projectSessions,
                theme: model.theme,
                expandedPeekId: model.expandedPeekId,
                peekCache: model.peekCache,
              },
              onEmit: {
                ToggledPeek: ({ sessionId }) => AppMessage.ToggledPeek({ sessionId }),
                RequestedRefreshPeek: ({ sessionId }) => AppMessage.RequestedRefreshPeek({ sessionId }),
                RequestedOpenTerminalStage: ({ sessionId }) => AppMessage.RequestedOpenTerminalStage({ sessionId }),
                SelectedForSend: ({ sessionId }) => AppMessage.SelectedForSend({ sessionId }),
                RequestedInterrupt: ({ sessionId }) => AppMessage.RequestedInterrupt({ sessionId }),
                RequestedArchive: ({ sessionId }) => AppMessage.RequestedArchive({ sessionId }),
              },
            }),
          ),
          h.div.class("flex min-h-36 flex-1 flex-col overflow-hidden").children(
            KnowledgePanel(h, {
              props: {
                files: projectFiles,
                activeFileId: activeStageFileId,
              },
              onEmit: {
                OpenedFile: ({ file }) => AppMessage.OpenedFile({ file }),
                AttachedFile: ({ relativePath }) => AppMessage.AttachedFile({ relativePath }),
              },
            }),
          ),
        ),
        model.toast !== null &&
          h.div
            .attrs({ role: "status", "data-testid": "toast-pill" })
            .class(
              "fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-popover px-3.5 py-1.5 text-xs font-medium text-popover-foreground shadow-lg",
            )
            .children(model.toast),
      )
  },
})

export const AppCommandLayers = Layer.mergeAll(
  LoadWorkspaceState.layer,
  LoadTimeline.layer,
  PeekSession.layer,
  SendSessionMessage.layer,
  InterruptSession.layer,
  ArchiveSession.layer,
)

export const App = AppNoDeps.pipe(
  Component.provide(AppCommandLayers.pipe(Layer.provideMerge(VibestWebApiBrowserLayer))),
)
