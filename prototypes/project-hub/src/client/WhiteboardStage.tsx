import { Excalidraw, convertToExcalidrawElements, restoreElements } from "@excalidraw/excalidraw"
import { CheckCircle2, Layers, MessageSquarePlus, PlusCircle, Sparkles } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"

import type { Artifact, CommentAnchor, CommentThread } from "../schema.ts"
import { hubApi } from "./api.ts"

const LooseElementSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    isDeleted: z.boolean().optional(),
    text: z.string().optional(),
    containerId: z.string().nullable().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  })
  .passthrough()

const LooseElementArraySchema = z.array(LooseElementSchema)

type ExcalidrawPropsType = Parameters<typeof Excalidraw>[0]

type ExcalidrawApiInstance = Parameters<NonNullable<ExcalidrawPropsType["excalidrawAPI"]>>[0]

type ExcalidrawElementList = ReturnType<ExcalidrawApiInstance["getSceneElements"]>

interface RestoredSceneState {
  elements: ReturnType<typeof restoreElements>
  viewBackgroundColor: string
}

function saveStatusText(saveState: "saved" | "saving" | "dirty"): string {
  switch (saveState) {
    case "saved":
      return "Auto-saved (.excalidraw)"
    case "saving":
      return "Saving scene..."
    case "dirty":
      return "Unsaved edits"
  }
}

function restoreSceneFromJson(raw: string): RestoredSceneState {
  try {
    const parsed = JSON.parse(raw)
    const elements = restoreElements(parsed?.elements ?? [], null)

    const bg =
      parsed?.appState?.viewBackgroundColor && String(parsed.appState.viewBackgroundColor).length > 0
        ? String(parsed.appState.viewBackgroundColor)
        : "#ffffff"

    return { elements, viewBackgroundColor: bg }
  } catch {
    return { elements: restoreElements([], null), viewBackgroundColor: "#ffffff" }
  }
}

function summarizeElementLabel(
  el: z.infer<typeof LooseElementSchema>,
  allElements: ReadonlyArray<z.infer<typeof LooseElementSchema>>,
): string {
  if (el.text && el.text.trim().length > 0) {
    return el.text.replace(/\s+/g, " ").trim().slice(0, 42)
  }

  const boundText = allElements.find(
    (candidate) => !candidate.isDeleted && candidate.containerId === el.id && candidate.text,
  )

  if (boundText?.text) {
    return boundText.text.replace(/\s+/g, " ").trim().slice(0, 42)
  }

  return `${el.type}:${el.id.slice(0, 12)}`
}

export function WhiteboardStage(props: {
  artifact: Artifact
  initialContent: string
  threads: CommentThread[]
  activeThreadId: string | null
  onCreateComment: (body: string, anchor: CommentAnchor) => Promise<void>
  onReloadRequested: () => Promise<void>
}) {
  const { artifact, initialContent, threads, activeThreadId, onCreateComment, onReloadRequested } = props

  const apiRef = useRef<ExcalidrawApiInstance | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedDigestRef = useRef<string>("")

  const initialContentRef = useRef<string>(initialContent)
  initialContentRef.current = initialContent

  const initialScene = useMemo(() => restoreSceneFromJson(initialContentRef.current), [artifact.id])

  const initialExcalidrawData = useMemo(
    () => ({
      elements: initialScene.elements,
      appState: {
        viewBackgroundColor: initialScene.viewBackgroundColor,
      },
      scrollToContent: true,
    }),
    [initialScene],
  )

  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved")
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [sceneNodes, setSceneNodes] = useState<Array<{ id: string; label: string; x: number; y: number }>>([])
  const [showPinComposer, setShowPinComposer] = useState(false)
  const [pinBody, setPinBody] = useState("")
  const [manualNodeId, setManualNodeId] = useState<string>("")

  const refreshNodeDirectory = useCallback((elements: ReadonlyArray<z.infer<typeof LooseElementSchema>>) => {
    const livePrimary = elements.flatMap((el) => {
      if (el.isDeleted) return []

      if (el.type === "text" && el.containerId) return []

      return [
        {
          id: el.id,
          label: summarizeElementLabel(el, elements),
          x: Math.round(el.x ?? 0),
          y: Math.round(el.y ?? 0),
        },
      ]
    })

    setSceneNodes((prev) => {
      if (
        prev.length === livePrimary.length &&
        prev.every(
          (item, idx) =>
            item.id === livePrimary[idx]?.id &&
            item.label === livePrimary[idx]?.label &&
            item.x === livePrimary[idx]?.x &&
            item.y === livePrimary[idx]?.y,
        )
      ) {
        return prev
      }

      return livePrimary
    })
  }, [])

  useEffect(() => {
    const loose = LooseElementArraySchema.parse(initialScene.elements)
    refreshNodeDirectory(loose)
    lastSavedDigestRef.current = JSON.stringify(
      loose.flatMap((e) => (e.isDeleted ? [] : [{ id: e.id, x: e.x, y: e.y, text: e.text }])),
    )
  }, [initialScene, refreshNodeDirectory])

  useEffect(() => {
    if (!activeThreadId || !apiRef.current) return
    const active = threads.find((t) => t.id === activeThreadId)

    if (!active || active.anchor.kind !== "whiteboard") return
    const anchorIds = active.anchor.elementIds

    const allEls = apiRef.current.getSceneElements()

    const targets = allEls.flatMap((el) => (!el.isDeleted && anchorIds.includes(el.id) ? [el] : []))

    const selectionMap: Record<string, true> = {}

    for (const id of anchorIds) {
      selectionMap[id] = true
    }

    apiRef.current.updateScene({
      appState: { selectedElementIds: selectionMap },
    })

    if (targets.length > 0) {
      apiRef.current.scrollToContent(targets, { fitToViewport: false, animate: true })
    }
  }, [activeThreadId, threads])

  const scheduleSave = useCallback(
    (elements: ExcalidrawElementList, viewBackgroundColor?: string) => {
      const loose = LooseElementArraySchema.parse(elements)

      const digest = JSON.stringify(
        loose.flatMap((e) => (e.isDeleted ? [] : [{ id: e.id, x: e.x, y: e.y, text: e.text }])),
      )

      if (digest === lastSavedDigestRef.current) return
      lastSavedDigestRef.current = digest
      setSaveState("dirty")

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }

      saveTimerRef.current = setTimeout(() => {
        setSaveState("saving")

        const payload = JSON.stringify(
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

        void hubApi
          .saveArtifactContent(artifact.id, { content: payload })
          .then(() => setSaveState("saved"))
          .catch(() => setSaveState("dirty"))
      }, 450)
    },
    [artifact.id],
  )

  const handleAddDiagramNode = async () => {
    if (!apiRef.current) return
    const current = apiRef.current.getSceneElements()
    const index = sceneNodes.length + 1
    const boxId = `node-custom-${Date.now().toString(36)}`
    const labelText = `Review Gate #${index}`
    const x = 435
    const y = 390 + ((index - 1) % 3) * 96

    const created = convertToExcalidrawElements([
      {
        id: boxId,
        type: "rectangle",
        x,
        y,
        width: 270,
        height: 82,
        backgroundColor: "#e0f2fe",
        strokeColor: "#0284c7",
        fillStyle: "solid",
        label: {
          text: labelText,
          fontSize: 14,
          fontFamily: 2,
        },
      },
    ])

    const primaryId = created[0]?.id ?? boxId
    const nextElements = [...current, ...created]
    apiRef.current.updateScene({
      elements: nextElements,
      appState: { selectedElementIds: { [primaryId]: true } },
    })
    setSelectedIds([primaryId])
    setManualNodeId(primaryId)
    refreshNodeDirectory(LooseElementArraySchema.parse(nextElements))
    scheduleSave(nextElements, "#ffffff")
  }

  const handleApplyTemplate = async (preset: "vibest-architecture" | "event-pipeline" | "multi-agent-review") => {
    const res = await hubApi.applyWhiteboardTemplate(artifact.id, preset)
    const restored = restoreSceneFromJson(res.content)

    if (apiRef.current) {
      apiRef.current.updateScene({ elements: restored.elements })
      apiRef.current.scrollToContent(restored.elements, { fitToViewport: true, animate: true })
    }

    refreshNodeDirectory(LooseElementArraySchema.parse(restored.elements))
    await onReloadRequested()
  }

  const effectiveTargetIds = selectedIds.length > 0 ? selectedIds : manualNodeId ? [manualNodeId] : []

  const handleSubmitElementComment = async () => {
    if (pinBody.trim().length === 0 || effectiveTargetIds.length === 0) return
    const targetNodes = sceneNodes.flatMap((n) => (effectiveTargetIds.includes(n.id) ? [n] : []))
    const first = targetNodes[0]
    await onCreateComment(pinBody.trim(), {
      kind: "whiteboard",
      elementIds: effectiveTargetIds,
      elementLabels: targetNodes.length > 0 ? targetNodes.map((n) => n.label) : effectiveTargetIds,
      ...(first !== undefined && { x: first.x, y: first.y }),
    })
    setPinBody("")
    setShowPinComposer(false)
  }

  const handleExcalidrawApi = useCallback((api: ExcalidrawApiInstance) => {
    apiRef.current = api
    setTimeout(() => {
      const els = api.getSceneElements()

      if (els.length > 0) {
        api.scrollToContent(els, { fitToViewport: true, animate: false })
      }
    }, 80)
  }, [])

  const handleExcalidrawChange = useCallback<NonNullable<ExcalidrawPropsType["onChange"]>>(
    (elements, appState) => {
      const parsedEls = LooseElementArraySchema.safeParse(elements)

      if (parsedEls.success) {
        refreshNodeDirectory(parsedEls.data)
      }

      scheduleSave(elements, appState.viewBackgroundColor)
      const rawSel = appState.selectedElementIds ?? {}
      const nextSelected = Object.entries(rawSel).flatMap(([id, picked]) => (picked ? [id] : []))

      setSelectedIds((prev) =>
        prev.length === nextSelected.length && prev.every((v, idx) => v === nextSelected[idx]) ? prev : nextSelected,
      )
    },
    [refreshNodeDirectory, scheduleSave],
  )

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 16px",
          background: "var(--bg-elevated)",
          borderBottom: "1px solid var(--border-subtle)",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <div className="btn-row">
          <button
            type="button"
            data-testid="wb-add-node-btn"
            className="btn btn-sm"
            onClick={() => void handleAddDiagramNode()}
          >
            <PlusCircle size={13} /> Add Architecture Node
          </button>

          <button
            type="button"
            data-testid="wb-pin-comment-btn"
            className="btn btn-primary btn-sm"
            onClick={() => {
              if (selectedIds.length === 0 && !manualNodeId && sceneNodes[0]) {
                setManualNodeId(sceneNodes[0].id)
              }

              setShowPinComposer((v) => !v)
            }}
          >
            <MessageSquarePlus size={13} />
            {selectedIds.length > 0
              ? `Pin Comment to ${selectedIds.length} Selected Element(s)`
              : "Pin Comment to Element"}
          </button>

          <div className="segmented" role="group" aria-label="Diagram Generator Templates">
            <button
              type="button"
              className="segmented-btn"
              onClick={() => void handleApplyTemplate("vibest-architecture")}
              title="Generate full Vibest + Hub topology"
            >
              <Sparkles size={12} /> Topology
            </button>
            <button
              type="button"
              className="segmented-btn"
              onClick={() => void handleApplyTemplate("event-pipeline")}
              title="Generate Append-Only Event Pipeline diagram"
            >
              <Layers size={12} /> Ledger Flow
            </button>
            <button
              type="button"
              className="segmented-btn"
              onClick={() => void handleApplyTemplate("multi-agent-review")}
              title="Generate Multi-Agent Review Loop diagram"
            >
              Review Loop
            </button>
          </div>
        </div>

        <span
          data-testid="wb-save-indicator"
          className={`badge ${saveState === "saved" ? "badge-green" : "badge-urgent"}`}
        >
          <CheckCircle2 size={12} />
          {saveStatusText(saveState)}
        </span>
      </div>

      {showPinComposer && (
        <div
          data-testid="wb-comment-composer"
          style={{
            padding: "10px 16px",
            background: "var(--bg-surface)",
            borderBottom: "1px solid var(--accent-blue)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <label style={{ fontSize: 12, fontWeight: 600 }}>Target Element:</label>
          <select
            data-testid="wb-element-select"
            className="input"
            style={{ width: 260, padding: "5px 8px" }}
            value={selectedIds[0] ?? manualNodeId}
            onChange={(ev) => {
              const chosen = ev.target.value
              setManualNodeId(chosen)
              setSelectedIds(chosen ? [chosen] : [])

              if (apiRef.current && chosen) {
                apiRef.current.updateScene({
                  appState: { selectedElementIds: { [chosen]: true } },
                })
              }
            }}
          >
            {sceneNodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label} ({n.id})
              </option>
            ))}
          </select>

          <input
            data-testid="wb-comment-input"
            className="input"
            style={{ flex: 1, minWidth: 220, padding: "6px 10px" }}
            placeholder="Comment anchored to selected Excalidraw element..."
            value={pinBody}
            onChange={(ev) => setPinBody(ev.target.value)}
          />
          <button
            type="button"
            data-testid="wb-comment-submit"
            className="btn btn-primary btn-sm"
            disabled={pinBody.trim().length === 0 || effectiveTargetIds.length === 0}
            onClick={() => void handleSubmitElementComment()}
          >
            Attach Element Pin
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setShowPinComposer(false)}>
            Cancel
          </button>
        </div>
      )}

      <div className="whiteboard-host" data-testid="excalidraw-stage">
        <Excalidraw
          excalidrawAPI={handleExcalidrawApi}
          initialData={initialExcalidrawData}
          onChange={handleExcalidrawChange}
        />
      </div>
    </div>
  )
}
