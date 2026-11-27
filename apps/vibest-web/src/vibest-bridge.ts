import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { cliHeaders, connect, HttpConnector, withHeaders } from "@vibest/client/client"
import { nodeUnixHttpClient } from "@vibest/client/unix-http.node"
import type { ProjectRow, WatchEvent, WatchSession } from "@vibest/protocol/schemas"
import { Effect, Layer, Match, Option, Schema, Stream } from "effect"

import {
  DemoStateSchema,
  type DaemonStatus,
  type PeekResult,
  type ProjectFileEntry,
  type ProjectSummary,
  type SessionItem,
  type StreamPayload,
  type TimelineEntry,
  type WorkspaceSnapshot,
} from "./domain/WebHub.ts"
import { scanProjectFiles, watchProjectDirectories } from "./project-files.ts"

const decodeDemoState = Schema.decodeUnknownOption(DemoStateSchema)

const httpLayer = Layer.succeed(HttpConnector.Service, nodeUnixHttpClient)

export interface BridgeOptions {
  readonly vibestHome: string
  readonly repositoryRoot: string
  readonly demoMode: boolean
  readonly safeActions: boolean
}

export interface VibestBridge {
  readonly snapshot: () => WorkspaceSnapshot
  readonly subscribe: (listener: (event: StreamPayload) => void) => () => void
  readonly getTimeline: (projectId: string, sessionId: string) => Promise<ReadonlyArray<TimelineEntry>>
  readonly peekSession: (sessionId: string) => Promise<PeekResult>
  readonly sendToSession: (
    sessionId: string,
    message: string,
    attachments: ReadonlyArray<string>,
  ) => Promise<{ readonly ok: boolean; readonly entry: TimelineEntry | null; readonly error?: string }>
  readonly interruptSession: (sessionId: string) => Promise<{ readonly ok: boolean; readonly message: string }>
  readonly archiveSession: (sessionId: string) => Promise<{ readonly ok: boolean; readonly message: string }>
  readonly refreshFiles: (projectId: string) => ReadonlyArray<ProjectFileEntry>
  readonly stop: () => void
}

function projectNameFromDir(directory: string | null, fallbackId: string): string {
  if (!directory) return fallbackId.slice(0, 8)
  const base = path.basename(directory.replace(/\/+$/, ""))

  return base.length > 0 ? base : fallbackId.slice(0, 8)
}

function isNeedsYou(status: SessionItem["status"], executionState: SessionItem["executionState"]): boolean {
  return status === "blocked" || executionState === "failed" || executionState === "lost"
}

function toSessionItem(raw: WatchSession): SessionItem {
  const isEntry = raw.parentId === null

  return {
    id: raw.id,
    name: raw.name || raw.id.slice(0, 8),
    agent: raw.agent,
    harness: raw.harness,
    provider: raw.provider,
    model: raw.model,
    status: raw.status,
    executionState: raw.executionState,
    projectId: raw.projectId,
    parentId: raw.parentId,
    runtime: raw.runtime,
    machine: raw.machine ?? "local",
    worktree: raw.worktree,
    repositoryRoot: raw.repositoryRoot,
    git: raw.git
      ? {
          branch: raw.git.branch,
          pushed: raw.git.pushed,
          saved: raw.git.saved,
          why: raw.git.why,
        }
      : null,
    createdAt: raw.createdAt,
    lastActive: raw.lastActive,
    startedAt: raw.startedAt,
    exitedAt: raw.exitedAt,
    task: raw.task,
    summary: raw.latest?.summary ?? "",
    isEntry,
    needsYou: isNeedsYou(raw.status, raw.executionState),
  }
}

interface RawProjectRecord {
  readonly id: string
  readonly directory: string | null
  readonly entrySessionId?: string | null | undefined
  readonly activity: ProjectRow["activity"]
  readonly name?: string | undefined
  readonly machine?: string | undefined
  readonly branch?: string | undefined
}

function summarizeProject(row: RawProjectRecord, sessions: ReadonlyArray<SessionItem>): ProjectSummary {
  const projectSessions = sessions.filter((s) => s.projectId === row.id)
  const entry = projectSessions.find((s) => s.id === row.entrySessionId || s.isEntry)
  let activeSubagents = 0
  let needsYouCount = 0

  for (const s of projectSessions) {
    if (!s.isEntry && s.exitedAt === null) {
      activeSubagents += 1
    }

    if (s.needsYou) {
      needsYouCount += 1
    }
  }

  const branch =
    row.branch ||
    entry?.git?.branch ||
    projectSessions.find((s) => s.git && s.git.branch.length > 0)?.git?.branch ||
    "main"

  return {
    id: row.id,
    name: row.name ?? projectNameFromDir(row.directory, row.id),
    directory: row.directory ?? path.join(os.homedir(), row.id.slice(0, 8)),
    entrySessionId: row.entrySessionId ?? entry?.id ?? null,
    activity: needsYouCount > 0 ? "blocked" : row.activity,
    machine: row.machine ?? entry?.machine ?? "local",
    activeSubagents,
    needsYouCount,
    totalSessions: projectSessions.length,
    branch,
  }
}

interface BridgeMutableState {
  daemon: DaemonStatus
  stopWatchers: () => void
  watchAbort: AbortController | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  closed: boolean
}

export function createVibestBridge(options: BridgeOptions): VibestBridge {
  const socketPath = path.join(options.vibestHome, "vibest.sock")
  const demoStatePath = path.join(options.vibestHome, "web-demo-state.json")

  const listeners = new Set<(event: StreamPayload) => void>()
  const rawProjects = new Map<string, RawProjectRecord>()
  const sessionsMap = new Map<string, SessionItem>()
  const filesByProject = new Map<string, ReadonlyArray<ProjectFileEntry>>()
  const timelinesBySession = new Map<string, TimelineEntry[]>()
  const demoPeeks = new Map<string, string>()

  const state: BridgeMutableState = {
    daemon: {
      connected: false,
      mode: "isolated",
      version: "0.0.2-dev",
      socket: socketPath,
      load: null,
    },
    stopWatchers: () => {},
    watchAbort: null,
    reconnectTimer: null,
    closed: false,
  }

  const emit = (event: StreamPayload) => {
    for (const listener of listeners) {
      listener(event)
    }
  }

  const computeProjects = (): ReadonlyArray<ProjectSummary> => {
    const allSessions = Array.from(sessionsMap.values())
    const list: ProjectSummary[] = []

    for (const row of rawProjects.values()) {
      list.push(summarizeProject(row, allSessions))
    }

    list.sort(
      (a, b) =>
        b.needsYouCount - a.needsYouCount || b.activeSubagents - a.activeSubagents || a.name.localeCompare(b.name),
    )

    return list
  }

  const computeFilesRecord = () => Object.fromEntries(filesByProject)

  const refreshFiles = (projectId: string): ReadonlyArray<ProjectFileEntry> => {
    const scanned = scanProjectFiles(options.vibestHome, projectId)
    filesByProject.set(projectId, scanned)
    emit({ type: "files-changed", data: { projectId, files: scanned } })

    return scanned
  }

  const attachFileWatchers = () => {
    state.stopWatchers()
    const ids = Array.from(rawProjects.keys())

    for (const id of ids) {
      filesByProject.set(id, scanProjectFiles(options.vibestHome, id))
    }

    state.stopWatchers = watchProjectDirectories(options.vibestHome, ids, (projectId) => {
      refreshFiles(projectId)
    })
  }

  const loadDemoFixturesIfPresent = () => {
    if (!fs.existsSync(demoStatePath)) return false

    try {
      const parsed = JSON.parse(fs.readFileSync(demoStatePath, "utf8"))
      const decoded = decodeDemoState(parsed)

      if (Option.isNone(decoded)) return false
      const data = decoded.value
      state.daemon = {
        connected: true,
        mode: "isolated",
        version: data.version,
        socket: socketPath,
        load: data.load,
      }

      for (const proj of data.projects) {
        rawProjects.set(proj.id, proj)
      }

      for (const session of data.sessions) {
        sessionsMap.set(session.id, session)
      }

      for (const entry of data.timelines) {
        const list = timelinesBySession.get(entry.sessionId) ?? []
        list.push(entry)
        timelinesBySession.set(entry.sessionId, list)
      }

      for (const [sessionId, ansi] of Object.entries(data.peeks)) {
        demoPeeks.set(sessionId, ansi)
      }

      attachFileWatchers()

      return true
    } catch {
      return false
    }
  }

  const discoverDiskProjects = () => {
    const projectsRoot = path.join(options.vibestHome, "projects")

    if (!fs.existsSync(projectsRoot)) return

    try {
      const entries = fs.readdirSync(projectsRoot, { withFileTypes: true })

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue

        if (!rawProjects.has(entry.name)) {
          rawProjects.set(entry.name, {
            id: entry.name,
            directory: path.join(projectsRoot, entry.name),
            entrySessionId: null,
            activity: "idle",
          })
        }
      }
    } catch {
      return
    }

    attachFileWatchers()
  }

  const snapshot = (): WorkspaceSnapshot => ({
    daemon: state.daemon,
    projects: computeProjects(),
    sessions: Array.from(sessionsMap.values()).sort((a, b) => b.lastActive - a.lastActive),
    filesByProject: computeFilesRecord(),
  })

  const applyWatchEvent = Match.type<WatchEvent>().pipe(
    Match.tag("Snapshot", (ev) => {
      rawProjects.clear()
      sessionsMap.clear()

      for (const project of ev.projects) {
        rawProjects.set(project.id, project)
      }

      for (const session of ev.sessions) {
        sessionsMap.set(session.id, toSessionItem(session))
      }

      attachFileWatchers()
      emit({ type: "snapshot", data: snapshot() })
    }),
    Match.tag("Project", (ev) => {
      const isNew = !rawProjects.has(ev.project.id)
      rawProjects.set(ev.project.id, ev.project)

      if (isNew) {
        attachFileWatchers()
      }

      const summary = summarizeProject(ev.project, Array.from(sessionsMap.values()))
      emit({ type: "project", data: summary })
    }),
    Match.tag("Session", (ev) => {
      const mapped = toSessionItem(ev.session)
      sessionsMap.set(mapped.id, mapped)
      emit({ type: "session", data: mapped })

      const projRow = rawProjects.get(mapped.projectId)

      if (projRow) {
        emit({ type: "project", data: summarizeProject(projRow, Array.from(sessionsMap.values())) })
      }
    }),
    Match.tag("SessionEnded", (ev) => {
      sessionsMap.delete(ev.id)
      timelinesBySession.delete(ev.id)
      emit({ type: "session-ended", data: { id: ev.id, projectId: ev.projectId } })

      const projRow = rawProjects.get(ev.projectId)

      if (projRow) {
        emit({ type: "project", data: summarizeProject(projRow, Array.from(sessionsMap.values())) })
      }
    }),
    Match.tag("Machine", () => {}),
    Match.tag("MachineRemoved", () => {}),
    Match.exhaustive,
  )

  const runLiveApi = <A, E>(
    fn: (client: Effect.Success<ReturnType<typeof connect>>) => Effect.Effect<A, E>,
  ): Promise<A> => {
    const program = connect(socketPath).pipe(
      Effect.flatMap((client) => withHeaders(fn(client), cliHeaders(options.repositoryRoot))),
      Effect.scoped,
      Effect.provide(httpLayer),
    )

    return Effect.runPromise(program)
  }

  const scheduleWatchReconnect = () => {
    if (state.closed || options.demoMode || state.reconnectTimer !== null) return

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null

      if (!state.closed) startLiveWatch()
    }, 2_000)
  }

  const startLiveWatch = () => {
    if (state.closed || options.demoMode) return

    if (!fs.existsSync(socketPath)) {
      scheduleWatchReconnect()

      return
    }

    state.watchAbort?.abort()
    const controller = new AbortController()
    state.watchAbort = controller

    const watchProgram = Effect.gen(function* () {
      const client = yield* connect(socketPath)
      const ping = yield* client["server.daemon"]["daemon.ping"]()

      const load = yield* withHeaders(
        client["server.machine"]["machine.load"]({ query: {} }).pipe(Effect.option),
        cliHeaders(options.repositoryRoot),
      )

      state.daemon = {
        connected: true,
        mode: "live",
        version: ping.version,
        socket: socketPath,
        load: Option.isSome(load)
          ? {
              sampledAt: load.value.sampledAt,
              cpuCount: load.value.cpu.count,
              cpuUtilization: load.value.cpu.utilization,
              memoryTotalBytes: load.value.memory.total,
              memoryAvailableBytes: load.value.memory.available,
              workingExecutions: load.value.executions.working,
            }
          : null,
      }
      emit({ type: "daemon", data: state.daemon })

      const watchStream = yield* withHeaders(
        client["server.watch"]["watch.subscribe"](),
        cliHeaders(options.repositoryRoot),
      )

      yield* Stream.runForEach(watchStream, (event) =>
        Effect.sync(() => {
          if (!state.closed) applyWatchEvent(event)
        }),
      )
    }).pipe(Effect.scoped, Effect.provide(httpLayer))

    void Effect.runPromise(watchProgram, { signal: controller.signal })
      .then(() => {
        if (!state.closed) {
          state.daemon = { ...state.daemon, connected: false }
          emit({ type: "daemon", data: state.daemon })
          scheduleWatchReconnect()
        }
      })
      .catch(() => {
        if (!state.closed) {
          state.daemon = { ...state.daemon, connected: false }
          emit({ type: "daemon", data: state.daemon })
          scheduleWatchReconnect()
        }
      })
  }

  const loadedDemo = loadDemoFixturesIfPresent()

  if (!loadedDemo) {
    discoverDiskProjects()
    startLiveWatch()
  }

  const getTimeline = async (projectId: string, sessionId: string): Promise<ReadonlyArray<TimelineEntry>> => {
    const stored = timelinesBySession.get(sessionId) ?? []
    const session = sessionsMap.get(sessionId)
    const entries: TimelineEntry[] = []

    const hasSeededFixture = stored.some((entry) => !entry.id.startsWith("msg-"))

    if (session?.task && !hasSeededFixture) {
      entries.push({
        id: `${sessionId}-task`,
        sessionId,
        projectId,
        role: "user",
        senderLabel: "Owner",
        senderSessionId: null,
        content: session.task,
        createdAt: session.createdAt,
        status: "completed",
        attachments: [],
      })
    }

    if (state.daemon.mode === "live" && state.daemon.connected) {
      try {
        const detail = await runLiveApi((client) =>
          client["server.session"]["session.get"]({ params: { id: sessionId }, query: {} }),
        )

        if (detail.reply?.text) {
          entries.push({
            id: `${sessionId}-reply-${detail.reply.execution}`,
            sessionId,
            projectId,
            role: "assistant",
            senderLabel: session?.name ?? sessionId.slice(0, 8),
            senderSessionId: sessionId,
            content: detail.reply.text,
            createdAt: detail.reply.endedAt ?? Date.now(),
            status: detail.reply.status === "failed" ? "failed" : "completed",
            attachments: [],
          })
        }
      } catch {}
    }

    for (const item of stored) {
      if (!entries.some((existing) => existing.id === item.id)) {
        entries.push(item)
      }
    }

    return entries
  }

  const peekSession = async (sessionId: string): Promise<PeekResult> => {
    const cachedDemo = demoPeeks.get(sessionId)

    if (cachedDemo !== undefined) {
      return {
        sessionId,
        text: cachedDemo,
        terminal: cachedDemo,
        updatedAt: Date.now(),
      }
    }

    if (state.daemon.mode === "live" && state.daemon.connected) {
      try {
        const res = await runLiveApi((client) =>
          client["server.session"]["session.peek"]({ params: { id: sessionId }, query: { lines: 80 } }),
        )

        return {
          sessionId,
          text: res.text,
          terminal: res.text,
          updatedAt: Date.now(),
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)

        return {
          sessionId,
          text: `Terminal peek unavailable: ${msg}`,
          terminal: `\x1b[33mTerminal peek unavailable:\x1b[0m ${msg}\r\n`,
          updatedAt: Date.now(),
        }
      }
    }

    const session = sessionsMap.get(sessionId)
    const defaultAnsi = `\x1b[1;36m[vibest]\x1b[0m session \x1b[32m${session?.name ?? sessionId.slice(0, 8)}\x1b[0m (${session?.harness ?? "claude"})\r\n\x1b[90mstatus:\x1b[0m ${session?.status ?? "idle"}\r\n`

    return {
      sessionId,
      text: defaultAnsi,
      terminal: defaultAnsi,
      updatedAt: Date.now(),
    }
  }

  const sendToSession = async (
    sessionId: string,
    message: string,
    attachments: ReadonlyArray<string>,
  ): Promise<{ readonly ok: boolean; readonly entry: TimelineEntry | null; readonly error?: string }> => {
    const trimmed = message.trim()

    if (trimmed.length === 0) {
      return { ok: false, entry: null, error: "Message is empty" }
    }

    const session = sessionsMap.get(sessionId)
    const projectId = session?.projectId ?? Array.from(rawProjects.keys())[0] ?? "default"

    const formattedMessage =
      attachments.length > 0 ? `${trimmed}\n\nAttached context: ${attachments.map((a) => `@${a}`).join(", ")}` : trimmed

    if (state.daemon.mode === "live" && state.daemon.connected && !options.safeActions) {
      try {
        await runLiveApi((client) =>
          client["server.session"]["session.send"]({
            params: { id: sessionId },
            payload: { message: formattedMessage },
          }),
        )
      } catch (err) {
        return { ok: false, entry: null, error: err instanceof Error ? err.message : String(err) }
      }
    }

    const entry: TimelineEntry = {
      id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      projectId,
      role: "user",
      senderLabel: "You",
      senderSessionId: null,
      content: trimmed,
      createdAt: Date.now(),
      status: "completed",
      attachments,
    }

    const list = timelinesBySession.get(sessionId) ?? []
    list.push(entry)
    timelinesBySession.set(sessionId, list)
    emit({ type: "timeline-entry", data: entry })

    if (session && state.daemon.mode === "isolated") {
      const updated: SessionItem = {
        ...session,
        status: "working",
        lastActive: Date.now(),
        needsYou: false,
      }

      sessionsMap.set(sessionId, updated)
      emit({ type: "session", data: updated })
    }

    return { ok: true, entry }
  }

  const interruptSession = async (sessionId: string): Promise<{ readonly ok: boolean; readonly message: string }> => {
    if (state.daemon.mode === "live" && state.daemon.connected && !options.safeActions) {
      try {
        const res = await runLiveApi((client) =>
          client["server.session"]["session.interrupt"]({ params: { id: sessionId }, query: {} }),
        )

        return { ok: true, message: res.message }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }

    const session = sessionsMap.get(sessionId)

    if (session) {
      const updated: SessionItem = {
        ...session,
        status: "idle",
        executionState: "interrupted",
        lastActive: Date.now(),
      }

      sessionsMap.set(sessionId, updated)
      emit({ type: "session", data: updated })
    }

    return { ok: true, message: `Interrupted ${sessionId.slice(0, 8)}` }
  }

  const archiveSession = async (sessionId: string): Promise<{ readonly ok: boolean; readonly message: string }> => {
    if (state.daemon.mode === "live" && state.daemon.connected && !options.safeActions) {
      try {
        await runLiveApi((client) =>
          client["server.session"]["session.archive"]({ params: { id: sessionId }, payload: {} }),
        )

        return { ok: true, message: `Archived ${sessionId.slice(0, 8)}` }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }

    const existing = sessionsMap.get(sessionId)

    if (existing) {
      sessionsMap.delete(sessionId)
      emit({ type: "session-ended", data: { id: sessionId, projectId: existing.projectId } })
    }

    return { ok: true, message: `Archived ${sessionId.slice(0, 8)}` }
  }

  return {
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    getTimeline,
    peekSession,
    sendToSession,
    interruptSession,
    archiveSession,
    refreshFiles,
    stop: () => {
      state.closed = true

      if (state.reconnectTimer !== null) {
        clearTimeout(state.reconnectTimer)
        state.reconnectTimer = null
      }

      state.watchAbort?.abort()
      state.watchAbort = null
      state.stopWatchers()
      listeners.clear()
    },
  }
}
