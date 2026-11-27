import { Component } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { HtmlLocator, HtmlPlay, HtmlScene } from "@effect/ui/html/testing"
import { Locator, Story, TestHost } from "@effect/ui/testing"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { AppCommandLayers, AppNoDeps } from "../src/client/App.ts"
import { KnowledgePanel, KnowledgePanelEvents, KnowledgePanelMessage } from "../src/client/components/KnowledgePanel.ts"
import { ProjectsPanel, ProjectsPanelEvents } from "../src/client/components/ProjectsPanel.ts"
import { SessionsPanel, SessionsPanelEvents, SessionsPanelMessage } from "../src/client/components/SessionsPanel.ts"
import {
  ExcalidrawStageMessage,
  ExcalidrawStageNoDeps,
  SaveBoardFile,
} from "../src/client/components/stage/ExcalidrawStage.ts"
import {
  MarkdownStage,
  MarkdownStageEvents,
  MarkdownStageMessage,
} from "../src/client/components/stage/MarkdownStage.ts"
import { LoadStageFile, StagePanelMessage, StagePanelNoDeps } from "../src/client/components/StagePanel.ts"
import { makeVibestWebApiMemoryLayer } from "../src/client/services/VibestWebApi.ts"
import type {
  DaemonStatus,
  ProjectFileEntry,
  ProjectSummary,
  SessionItem,
  TimelineEntry,
  WorkspaceSnapshot,
} from "../src/domain/WebHub.ts"

const sampleDaemon: DaemonStatus = {
  connected: true,
  mode: "isolated",
  version: "0.0.2-dev",
  socket: "/tmp/vibest/vibest.sock",
  load: {
    sampledAt: 1_700_000_000_000,
    cpuCount: 12,
    cpuUtilization: 0.25,
    memoryTotalBytes: 32 * 1024 ** 3,
    memoryAvailableBytes: 16 * 1024 ** 3,
    workingExecutions: 1,
  },
}

const sampleProjects: ReadonlyArray<ProjectSummary> = [
  {
    id: "proj-vibest",
    name: "vibest",
    directory: "/Users/dev/vibest",
    entrySessionId: "entry-1",
    activity: "working",
    machine: "local",
    activeSubagents: 2,
    needsYouCount: 1,
    totalSessions: 3,
    branch: "feat/web-hub-cursor-panels",
  },
  {
    id: "proj-docs",
    name: "docs-site",
    directory: "/Users/dev/docs-site",
    entrySessionId: "entry-2",
    activity: "idle",
    machine: "remote-1",
    activeSubagents: 0,
    needsYouCount: 0,
    totalSessions: 1,
    branch: "main",
  },
]

const sampleSessions: ReadonlyArray<SessionItem> = [
  {
    id: "entry-1",
    name: "coordinator",
    agent: "coordinator",
    harness: "claude",
    provider: null,
    model: "opus",
    status: "idle",
    executionState: "completed",
    projectId: "proj-vibest",
    parentId: null,
    runtime: "hc",
    machine: "local",
    worktree: "/Users/dev/vibest",
    repositoryRoot: "/Users/dev/vibest",
    git: { branch: "main", pushed: true, saved: true, why: "" },
    createdAt: 1_700_000_000_000,
    lastActive: 1_700_000_050_000,
    startedAt: 1_700_000_000_000,
    exitedAt: null,
    task: "Coordinate Effect UI port",
    summary: "Ready",
    isEntry: true,
    needsYou: false,
  },
  {
    id: "sub-working-1",
    name: "ui-port",
    agent: "general",
    harness: "agy",
    provider: null,
    model: "gemini",
    status: "working",
    executionState: "open",
    projectId: "proj-vibest",
    parentId: "entry-1",
    runtime: "hc",
    machine: "local",
    worktree: "/tmp/wt-ui",
    repositoryRoot: "/Users/dev/vibest",
    git: { branch: "feat/effect-ui", pushed: false, saved: true, why: "" },
    createdAt: 1_700_000_010_000,
    lastActive: 1_700_000_060_000,
    startedAt: 1_700_000_010_000,
    exitedAt: null,
    task: "Port panels to Effect UI",
    summary: "Porting StagePanel",
    isEntry: false,
    needsYou: false,
  },
  {
    id: "sub-blocked-2",
    name: "security-audit",
    agent: "reviewer",
    harness: "pi",
    provider: null,
    model: "astra",
    status: "blocked",
    executionState: "open",
    projectId: "proj-vibest",
    parentId: "entry-1",
    runtime: "hc",
    machine: "local",
    worktree: "/tmp/wt-sec",
    repositoryRoot: "/Users/dev/vibest",
    git: { branch: "audit/b1-b6", pushed: true, saved: true, why: "" },
    createdAt: 1_700_000_020_000,
    lastActive: 1_700_000_070_000,
    startedAt: 1_700_000_020_000,
    exitedAt: null,
    task: "Check B1-B6",
    summary: "Waiting for approval",
    isEntry: false,
    needsYou: true,
  },
]

const sampleFiles: ReadonlyArray<ProjectFileEntry> = [
  {
    id: "f-spec",
    projectId: "proj-vibest",
    category: "artifacts",
    name: "spec.md",
    relativePath: "artifacts/spec.md",
    extension: ".md",
    size: 512,
    updatedAt: 1_700_000_000_000,
    kind: "markdown",
  },
  {
    id: "f-board",
    projectId: "proj-vibest",
    category: "artifacts",
    name: "arch.excalidraw",
    relativePath: "artifacts/arch.excalidraw",
    extension: ".excalidraw",
    size: 1024,
    updatedAt: 1_700_000_000_000,
    kind: "excalidraw",
  },
  {
    id: "f-doc",
    projectId: "proj-vibest",
    category: "docs",
    name: "architecture.md",
    relativePath: "docs/architecture.md",
    extension: ".md",
    size: 2048,
    updatedAt: 1_700_000_000_000,
    kind: "markdown",
  },
  {
    id: "f-prefs",
    projectId: "proj-vibest",
    category: "preferences",
    name: "preferences.md",
    relativePath: "preferences.md",
    extension: ".md",
    size: 256,
    updatedAt: 1_700_000_000_000,
    kind: "markdown",
  },
]

const sampleTimeline: ReadonlyArray<TimelineEntry> = [
  {
    id: "t-1",
    sessionId: "entry-1",
    projectId: "proj-vibest",
    role: "user",
    senderLabel: "Owner",
    senderSessionId: null,
    content: "Port Vibest Web Hub to Effect UI.",
    createdAt: 1_700_000_000_000,
    status: "completed",
    attachments: [],
  },
]

const sampleSnapshot: WorkspaceSnapshot = {
  daemon: sampleDaemon,
  projects: sampleProjects,
  sessions: sampleSessions,
  filesByProject: { "proj-vibest": sampleFiles },
}

const NoopHtmlHost = Layer.succeed(Html.Host, {
  focus: () => {},
  blur: () => {},
  scrollIntoView: () => {},
  measure: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  select: () => {},
  requestSubmit: () => false,
  showPicker: () => false,
})

describe("Effect UI components (Story & HtmlScene)", () => {
  it.effect("ProjectsPanel filters projects and emits selection and theme toggle", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(ProjectsPanel, {
        projects: sampleProjects,
        selectedProjectId: "proj-vibest",
        daemon: sampleDaemon,
        theme: "dark",
      })

      s.expect(Locator.testId("project-item-vibest")).toExist()
      s.expect(Locator.testId("project-item-docs-site")).toExist()

      s.type(HtmlLocator.role("textbox", { name: "Filter projects" }), "docs")
      s.expect(Locator.testId("project-item-vibest")).toBeAbsent()
      s.expect(Locator.testId("project-item-docs-site")).toExist()

      s.click(Locator.testId("project-item-docs-site")).emitted(
        ProjectsPanelEvents.SelectedProject({ projectId: "proj-docs" }),
      )

      s.click(Locator.testId("theme-toggle-btn")).emitted(ProjectsPanelEvents.ToggledTheme())
    }),
  )

  it.effect("SessionsPanel filters branch sessions and emits actions", () =>
    Effect.gen(function* () {
      const s = yield* Story.make(SessionsPanel, {
        sessions: sampleSessions,
        theme: "dark",
        expandedPeekId: null,
        peekCache: {},
      })

      assert.strictEqual(s.model.filter, "all")
      s.send(SessionsPanelMessage.SelectedFilter({ filter: "needs_you" }))
      assert.strictEqual(s.model.filter, "needs_you")

      s.send(SessionsPanelMessage.ToggledPeek({ sessionId: "sub-working-1" })).emitted(
        SessionsPanelEvents.ToggledPeek({ sessionId: "sub-working-1" }),
      )
      s.send(SessionsPanelMessage.ClickedInterrupt({ sessionId: "sub-working-1" })).emitted(
        SessionsPanelEvents.RequestedInterrupt({ sessionId: "sub-working-1" }),
      )
      s.send(SessionsPanelMessage.ClickedArchive({ sessionId: "sub-blocked-2" })).emitted(
        SessionsPanelEvents.RequestedArchive({ sessionId: "sub-blocked-2" }),
      )
    }),
  )

  it.effect("KnowledgePanel switches categories and emits open/attach events", () =>
    Effect.gen(function* () {
      const s = yield* Story.make(KnowledgePanel, {
        files: sampleFiles,
        activeFileId: null,
      })

      assert.strictEqual(s.model.tab, "artifacts")
      s.send(KnowledgePanelMessage.SelectedTab({ tab: "docs" }))
      assert.strictEqual(s.model.tab, "docs")

      s.send(KnowledgePanelMessage.ClickedOpenFile({ file: sampleFiles[2]! })).emitted(
        KnowledgePanelEvents.OpenedFile({ file: sampleFiles[2]! }),
      )
      s.send(KnowledgePanelMessage.ClickedAttachFile({ relativePath: "docs/architecture.md" })).emitted(
        KnowledgePanelEvents.AttachedFile({ relativePath: "docs/architecture.md" }),
      )
    }),
  )

  it.effect("StagePanel loads file content, MarkdownStage emits feedback, and ExcalidrawStage saves boards", () =>
    Effect.gen(function* () {
      const stageStory = yield* Story.make(StagePanelNoDeps, {
        item: { kind: "file", file: sampleFiles[0]! },
        theme: "dark",
        sessions: sampleSessions,
        peekText: "",
      })

      stageStory.expectExact(LoadStageFile).resolve(
        LoadStageFile,
        StagePanelMessage.SucceededLoadFile({
          fileId: "f-spec",
          content: "# Effect UI Spec\n\nClean Elm architecture.",
        }),
      )

      assert.strictEqual(stageStory.model.loading, false)
      assert.strictEqual(stageStory.model.content, "# Effect UI Spec\n\nClean Elm architecture.")

      const mdStory = yield* Story.make(MarkdownStage, {
        file: sampleFiles[0]!,
        content: "# Effect UI Spec\n\nClean Elm architecture.",
        theme: "dark",
      })

      mdStory.send(MarkdownStageMessage.ClickedComment())
      assert.strictEqual(mdStory.model.selectedQuote, "Effect UI Spec")

      mdStory.send(MarkdownStageMessage.UpdatedNote({ note: "Looks solid" }))
      mdStory.send(MarkdownStageMessage.ClickedAddToComposer()).emitted(
        MarkdownStageEvents.AddedToComposer({
          text: '[Feedback on @artifacts/spec.md]\n> "Effect UI Spec"\nLooks solid',
          attachmentPath: "artifacts/spec.md",
        }),
      )

      const boardStory = yield* Story.make(ExcalidrawStageNoDeps, {
        file: sampleFiles[1]!,
        initialContent: '{"type":"excalidraw","version":2,"elements":[]}',
        theme: "dark",
      })

      boardStory.send(ExcalidrawStageMessage.ClickedAddNode())
      assert.strictEqual(boardStory.model.nodes.length, 1)
      assert.strictEqual(boardStory.model.saveLabel, "Unsaved")

      boardStory
        .send(ExcalidrawStageMessage.ClickedSave())
        .expectExact(SaveBoardFile)
        .resolve(SaveBoardFile, ExcalidrawStageMessage.SucceededSave())

      assert.strictEqual(boardStory.model.saveLabel, "Saved")
    }),
  )
})

const AppMemoryTest = AppNoDeps.pipe(
  Component.provide(
    AppCommandLayers.pipe(
      Layer.provideMerge(
        makeVibestWebApiMemoryLayer({
          snapshot: sampleSnapshot,
          timelines: { "entry-1": sampleTimeline },
          files: {
            "proj-vibest:artifacts/spec.md": "# Effect UI Architecture\n\nBuilt on @effect/ui.",
          },
        }),
      ),
    ),
  ),
)

it.layer(Layer.mergeAll(TestHost.layer(), NoopHtmlHost), { buildPerTest: true })(
  "VibestWebApp end-to-end HtmlPlay on TestHost",
  (it) => {
    it.effect("loads workspace, opens artifact in stage, adds feedback, and dispatches message", () =>
      Effect.gen(function* () {
        const play = yield* HtmlPlay.make(AppMemoryTest, {})

        yield* play.expect(Locator.testId("workspace-canvas")).toExist()
        yield* play.expect(Locator.testId("projects-panel")).toExist()
        yield* play.expect(Locator.testId("chat-panel")).toExist()
        yield* play.expect(Locator.testId("sessions-panel")).toExist()
        yield* play.expect(Locator.testId("knowledge-panel")).toExist()
        yield* play.expect(Locator.testId("project-item-vibest")).toExist()

        yield* play.click(Locator.testId("attach-file-spec.md"))
        yield* play.expect(Locator.testId("composer-chips")).toExist()

        yield* play.type(Locator.testId("composer-textarea"), "Ship Effect UI hub")
        yield* play.click(Locator.testId("composer-send-btn"))
        yield* play.expect(Locator.testId("toast-pill")).toHaveText("Dispatched message via vibestd")
      }),
    )
  },
)
