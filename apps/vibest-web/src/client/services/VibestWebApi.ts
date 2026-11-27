import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect"

import {
  DaemonStatusSchema,
  PeekResultSchema,
  ProjectFileEntrySchema,
  ProjectSummarySchema,
  SessionItemSchema,
  TimelineEntrySchema,
  WebApiError,
  WorkspaceSnapshotSchema,
  type PeekResult,
  type ProjectFileEntry,
  type StreamPayload,
  type TimelineEntry,
  type WorkspaceSnapshot,
} from "../../domain/WebHub.ts"

export interface VibestWebApiClient {
  readonly getState: () => Effect.Effect<WorkspaceSnapshot, WebApiError>
  readonly getTimeline: (
    projectId: string,
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<TimelineEntry>, WebApiError>
  readonly getFiles: (projectId: string) => Effect.Effect<ReadonlyArray<ProjectFileEntry>, WebApiError>
  readonly getFileContent: (projectId: string, relativePath: string) => Effect.Effect<string, WebApiError>
  readonly saveFileContent: (
    projectId: string,
    relativePath: string,
    content: string,
  ) => Effect.Effect<ReadonlyArray<ProjectFileEntry>, WebApiError>
  readonly peekSession: (sessionId: string) => Effect.Effect<PeekResult, WebApiError>
  readonly sendToSession: (
    sessionId: string,
    message: string,
    attachments: ReadonlyArray<string>,
  ) => Effect.Effect<
    { readonly ok: boolean; readonly entry: TimelineEntry | null; readonly error: string | null },
    WebApiError
  >
  readonly interruptSession: (
    sessionId: string,
  ) => Effect.Effect<{ readonly ok: boolean; readonly message: string }, WebApiError>
  readonly archiveSession: (
    sessionId: string,
  ) => Effect.Effect<{ readonly ok: boolean; readonly message: string }, WebApiError>
  readonly streamEvents: () => Stream.Stream<StreamPayload>
}

export class VibestWebApi extends Context.Service<VibestWebApi, VibestWebApiClient>()("vibest-web/VibestWebApi") {}

const decodeSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(WorkspaceSnapshotSchema))
const decodeDaemon = Schema.decodeUnknownOption(Schema.fromJsonString(DaemonStatusSchema))
const decodeProject = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectSummarySchema))
const decodeSession = Schema.decodeUnknownOption(Schema.fromJsonString(SessionItemSchema))

const decodeSessionEnded = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, projectId: Schema.String })),
)

const decodeFilesChanged = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ projectId: Schema.String, files: Schema.Array(ProjectFileEntrySchema) })),
)

const decodeTimelineEntry = Schema.decodeUnknownOption(Schema.fromJsonString(TimelineEntrySchema))

const decodeTimelineResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ entries: Schema.Array(TimelineEntrySchema) })),
)

const decodeFilesResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ files: Schema.Array(ProjectFileEntrySchema) })),
)

const decodeFileContentResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ content: Schema.String })),
)

const decodeSaveFileResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ ok: Schema.Boolean, files: Schema.Array(ProjectFileEntrySchema) })),
)

const decodePeekResult = Schema.decodeUnknownOption(Schema.fromJsonString(PeekResultSchema))

const decodeSendResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ok: Schema.Boolean,
      entry: Schema.NullOr(TimelineEntrySchema),
      error: Schema.optional(Schema.String),
    }),
  ),
)

const decodeActionResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ ok: Schema.Boolean, message: Schema.String })),
)

function fetchJsonText(url: string, init?: RequestInit): Effect.Effect<string, WebApiError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, init)

      if (!res.ok) {
        throw new Error(`Request failed (${res.status}): ${url}`)
      }

      return res.text()
    },
    catch: (cause) => new WebApiError({ message: cause instanceof Error ? cause.message : String(cause) }),
  })
}

function decodeOrFail<A>(
  url: string,
  decode: (rawJson: string) => Option.Option<A>,
  rawJson: string,
): Effect.Effect<A, WebApiError> {
  const decoded = decode(rawJson)

  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(new WebApiError({ message: `Invalid response payload from ${url}` }))
}

function makeEventSourceStream(): Stream.Stream<StreamPayload> {
  return Stream.callback<StreamPayload>(
    Effect.fnUntraced(function* (queue) {
      if (typeof EventSource === "undefined") return

      const source = yield* Effect.acquireRelease(
        Effect.sync(() => new EventSource("/api/stream")),
        (es) => Effect.sync(() => es.close()),
      )

      const forward = <A>(
        eventName: string,
        decode: (rawJson: string) => Option.Option<A>,
        wrap: (value: A) => StreamPayload,
      ) => {
        source.addEventListener(eventName, (ev: MessageEvent) => {
          const decoded = decode(String(ev.data))

          if (Option.isSome(decoded)) {
            Queue.offerUnsafe(queue, wrap(decoded.value))
          }
        })
      }

      forward("snapshot", decodeSnapshot, (data) => ({ type: "snapshot", data }))
      forward("daemon", decodeDaemon, (data) => ({ type: "daemon", data }))
      forward("project", decodeProject, (data) => ({ type: "project", data }))
      forward("session", decodeSession, (data) => ({ type: "session", data }))
      forward("session-ended", decodeSessionEnded, (data) => ({ type: "session-ended", data }))
      forward("files-changed", decodeFilesChanged, (data) => ({ type: "files-changed", data }))
      forward("timeline-entry", decodeTimelineEntry, (data) => ({ type: "timeline-entry", data }))
    }),
  )
}

export const VibestWebApiBrowserLayer = Layer.succeed(VibestWebApi, {
  getState: () =>
    fetchJsonText("/api/state").pipe(Effect.flatMap((raw) => decodeOrFail("/api/state", decodeSnapshot, raw))),

  getTimeline: (projectId, sessionId) => {
    const url = `/api/projects/${encodeURIComponent(projectId)}/timeline?sessionId=${encodeURIComponent(sessionId)}`

    return fetchJsonText(url).pipe(
      Effect.flatMap((raw) => decodeOrFail(url, decodeTimelineResponse, raw)),
      Effect.map((res) => res.entries),
    )
  },

  getFiles: (projectId) => {
    const url = `/api/projects/${encodeURIComponent(projectId)}/files`

    return fetchJsonText(url).pipe(
      Effect.flatMap((raw) => decodeOrFail(url, decodeFilesResponse, raw)),
      Effect.map((res) => res.files),
    )
  },

  getFileContent: (projectId, relativePath) => {
    const url = `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(relativePath)}`

    return fetchJsonText(url).pipe(
      Effect.flatMap((raw) => decodeOrFail(url, decodeFileContentResponse, raw)),
      Effect.map((res) => res.content),
    )
  },

  saveFileContent: (projectId, relativePath, content) => {
    const url = `/api/projects/${encodeURIComponent(projectId)}/file`

    return fetchJsonText(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: relativePath, content }),
    }).pipe(
      Effect.flatMap((raw) => decodeOrFail(url, decodeSaveFileResponse, raw)),
      Effect.map((res) => res.files),
    )
  },

  peekSession: (sessionId) => {
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/peek`

    return fetchJsonText(url).pipe(Effect.flatMap((raw) => decodeOrFail(url, decodePeekResult, raw)))
  },

  sendToSession: (sessionId, message, attachments) => {
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/send`

    return fetchJsonText(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, attachments }),
    }).pipe(
      Effect.flatMap((raw) => decodeOrFail(url, decodeSendResponse, raw)),
      Effect.map((res) => ({ ok: res.ok, entry: res.entry, error: res.error ?? null })),
    )
  },

  interruptSession: (sessionId) => {
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`

    return fetchJsonText(url, { method: "POST" }).pipe(
      Effect.flatMap((raw) => decodeOrFail(url, decodeActionResponse, raw)),
    )
  },

  archiveSession: (sessionId) => {
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/archive`

    return fetchJsonText(url, { method: "POST" }).pipe(
      Effect.flatMap((raw) => decodeOrFail(url, decodeActionResponse, raw)),
    )
  },

  streamEvents: makeEventSourceStream,
})

export function makeVibestWebApiMemoryLayer(options: {
  readonly snapshot: WorkspaceSnapshot
  readonly timelines?: Readonly<Record<string, ReadonlyArray<TimelineEntry>>>
  readonly files?: Readonly<Record<string, string>>
  readonly peeks?: Readonly<Record<string, string>>
  readonly stream?: Stream.Stream<StreamPayload>
}): Layer.Layer<VibestWebApi> {
  return Layer.sync(VibestWebApi, () => {
    const filesStore = new Map<string, string>(Object.entries(options.files ?? {}))

    const timelineStore = new Map<string, Array<TimelineEntry>>(
      Object.entries(options.timelines ?? {}).map(([k, v]) => [k, [...v]]),
    )

    const peekStore = new Map<string, string>(Object.entries(options.peeks ?? {}))

    return {
      getState: () => Effect.succeed(options.snapshot),
      getTimeline: (_projectId, sessionId) => Effect.succeed(timelineStore.get(sessionId) ?? []),
      getFiles: (projectId) => Effect.succeed(options.snapshot.filesByProject[projectId] ?? []),
      getFileContent: (projectId, relativePath) =>
        Effect.succeed(filesStore.get(`${projectId}:${relativePath}`) ?? filesStore.get(relativePath) ?? ""),
      saveFileContent: (projectId, relativePath, content) =>
        Effect.sync(() => {
          filesStore.set(`${projectId}:${relativePath}`, content)
          filesStore.set(relativePath, content)

          return options.snapshot.filesByProject[projectId] ?? []
        }),
      peekSession: (sessionId) =>
        Effect.succeed({
          sessionId,
          text: peekStore.get(sessionId) ?? `[vibest] ${sessionId}\r\n`,
          terminal: peekStore.get(sessionId) ?? `[vibest] ${sessionId}\r\n`,
          updatedAt: Date.now(),
        }),
      sendToSession: (sessionId, message, attachments) =>
        Effect.sync(() => {
          const entry: TimelineEntry = {
            id: `msg-${Date.now().toString(36)}`,
            sessionId,
            projectId: options.snapshot.projects[0]?.id ?? "default",
            role: "user",
            senderLabel: "You",
            senderSessionId: null,
            content: message.trim(),
            createdAt: Date.now(),
            status: "completed",
            attachments,
          }

          const list = timelineStore.get(sessionId) ?? []
          list.push(entry)
          timelineStore.set(sessionId, list)

          return { ok: true, entry, error: null }
        }),
      interruptSession: (sessionId) => Effect.succeed({ ok: true, message: `Interrupted ${sessionId.slice(0, 8)}` }),
      archiveSession: (sessionId) => Effect.succeed({ ok: true, message: `Archived ${sessionId.slice(0, 8)}` }),
      streamEvents: () => options.stream ?? Stream.never,
    }
  })
}
