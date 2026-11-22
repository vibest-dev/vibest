import { z } from "zod"

export type WhiteboardSaveStatus = "saved" | "saving" | "dirty"

const ActiveElementRefSchema = z
  .object({
    id: z.string().optional(),
  })
  .passthrough()
  .nullable()
  .optional()

export const WhiteboardElementDigestItemSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    version: z.number().optional(),
    versionNonce: z.number().optional(),
    isDeleted: z.boolean().optional(),
    text: z.string().optional(),
    containerId: z.string().nullable().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    backgroundColor: z.string().optional(),
    strokeColor: z.string().optional(),
  })
  .passthrough()

export const WhiteboardElementDigestArraySchema = z.array(WhiteboardElementDigestItemSchema)

export type WhiteboardDigestElement = z.infer<typeof WhiteboardElementDigestItemSchema>

export const WhiteboardInteractionAppStateSchema = z
  .object({
    viewBackgroundColor: z.string().optional(),
    draggingElement: ActiveElementRefSchema,
    resizingElement: ActiveElementRefSchema,
    editingElement: ActiveElementRefSchema,
    editingTextElement: ActiveElementRefSchema,
    newElement: ActiveElementRefSchema,
    multiElement: ActiveElementRefSchema,
    isResizing: z.boolean().optional(),
    isRotating: z.boolean().optional(),
    cursorButton: z.string().optional(),
  })
  .passthrough()

export type WhiteboardInteractionAppState = z.infer<typeof WhiteboardInteractionAppStateSchema>

export function computeWhiteboardSceneDigest(
  elements: ReadonlyArray<WhiteboardDigestElement>,
  viewBackgroundColor?: string,
): string {
  return JSON.stringify({
    bg: viewBackgroundColor ?? "#ffffff",
    elements: elements.map((el) => ({
      id: el.id,
      version: el.version ?? 0,
      versionNonce: el.versionNonce ?? 0,
      isDeleted: Boolean(el.isDeleted),
    })),
  })
}

export function isWhiteboardInteractionActive(appState: WhiteboardInteractionAppState): boolean {
  return Boolean(
    appState.draggingElement ||
    appState.resizingElement ||
    appState.editingElement ||
    appState.editingTextElement ||
    appState.newElement ||
    appState.multiElement ||
    appState.isResizing ||
    appState.isRotating ||
    appState.cursorButton === "down",
  )
}

export function serializeExcalidrawScenePayload(
  elements: ReadonlyArray<WhiteboardDigestElement>,
  viewBackgroundColor?: string,
): string {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "https://vibest.local/project-hub",
      elements,
      appState: {
        viewBackgroundColor: viewBackgroundColor ?? "#ffffff",
      },
      files: {},
    },
    null,
    2,
  )
}

interface PendingSceneSnapshot {
  readonly elements: ReadonlyArray<WhiteboardDigestElement>
  readonly viewBackgroundColor: string
  readonly digest: string
}

export class WhiteboardAutoSaver {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastCommittedDigest = ""
  private latestSnapshot: PendingSceneSnapshot | null = null
  private readonly saveSceneJson: (payload: string) => Promise<void>
  private readonly onStatusChange: (status: WhiteboardSaveStatus) => void
  private readonly debounceMs: number

  constructor(
    saveSceneJson: (payload: string) => Promise<void>,
    onStatusChange: (status: WhiteboardSaveStatus) => void,
    debounceMs = 300,
  ) {
    this.saveSceneJson = saveSceneJson
    this.onStatusChange = onStatusChange
    this.debounceMs = debounceMs
  }

  resetBaseline(elements: ReadonlyArray<WhiteboardDigestElement>, viewBackgroundColor?: string): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    const bg = viewBackgroundColor ?? "#ffffff"
    const digest = computeWhiteboardSceneDigest(elements, bg)
    this.lastCommittedDigest = digest
    this.latestSnapshot = { elements, viewBackgroundColor: bg, digest }
    this.onStatusChange("saved")
  }

  recordChange(elements: ReadonlyArray<WhiteboardDigestElement>, appState: WhiteboardInteractionAppState): void {
    const bg = appState.viewBackgroundColor ?? "#ffffff"
    const digest = computeWhiteboardSceneDigest(elements, bg)
    this.latestSnapshot = { elements, viewBackgroundColor: bg, digest }

    if (digest === this.lastCommittedDigest) {
      if (this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
        this.onStatusChange("saved")
      }

      return
    }

    this.onStatusChange("dirty")

    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (isWhiteboardInteractionActive(appState)) {
      return
    }

    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.debounceMs)
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    const snapshot = this.latestSnapshot

    if (!snapshot || snapshot.digest === this.lastCommittedDigest) {
      return
    }

    this.lastCommittedDigest = snapshot.digest
    this.onStatusChange("saving")
    const payload = serializeExcalidrawScenePayload(snapshot.elements, snapshot.viewBackgroundColor)

    try {
      await this.saveSceneJson(payload)

      if (this.latestSnapshot?.digest === snapshot.digest) {
        this.onStatusChange("saved")
      }
    } catch {
      this.lastCommittedDigest = ""
      this.onStatusChange("dirty")
    }
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (this.latestSnapshot && this.latestSnapshot.digest !== this.lastCommittedDigest) {
      void this.flush()
    }
  }
}
