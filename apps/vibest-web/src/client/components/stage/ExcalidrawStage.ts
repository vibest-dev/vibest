import { Command, Component, UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Effect, Option, Schema } from "effect"

import { BoardNodeSchema, ProjectFileEntrySchema, ThemeModeSchema, type BoardNode } from "../../../domain/WebHub.ts"
import { VibestWebApi } from "../../services/VibestWebApi.ts"
import { IconMessagePlus, IconPlusCircle, IconSave } from "../../ui/icons.ts"
import { Badge, buttonClass } from "../../ui/primitives.ts"

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

export function parseExcalidrawNodes(raw: string): ReadonlyArray<BoardNode> {
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
  const elements = nodes.flatMap((node) => {
    const textId = `${node.id}-label`

    return [
      {
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
      },
      {
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
      },
    ]
  })

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

export const ExcalidrawStageMessage = UiSchema.TaggedEnum({
  ClickedAddNode: {},
  ClickedSave: {},
  SucceededSave: {},
  FailedSave: {},
  ClickedAddToComposer: {},
})

export const ExcalidrawStageEvents = UiSchema.TaggedEnum({
  AddedToComposer: { text: Schema.String, attachmentPath: Schema.String },
})

export class SaveBoardFile extends Command.Service<SaveBoardFile>()("vibest-web/SaveBoardFile", {
  args: {
    projectId: Schema.String,
    relativePath: Schema.String,
    content: Schema.String,
  },
  success: ExcalidrawStageMessage,
  mode: "queue",
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* VibestWebApi

      return ({ projectId, relativePath, content }) =>
        api.saveFileContent(projectId, relativePath, content).pipe(
          Effect.match({
            onSuccess: () => ExcalidrawStageMessage.SucceededSave(),
            onFailure: () => ExcalidrawStageMessage.FailedSave(),
          }),
        )
    }),
  )
}

const ExcalidrawStageDef = Html.component({
  name: "ExcalidrawStage",
  props: Schema.Struct({
    file: ProjectFileEntrySchema,
    initialContent: Schema.String,
    theme: ThemeModeSchema,
  }),
  model: Schema.Struct({
    nodes: Schema.Array(BoardNodeSchema),
    saveLabel: Schema.String,
  }),
  message: ExcalidrawStageMessage,
  events: ExcalidrawStageEvents,
})

export const ExcalidrawStageNoDeps = ExcalidrawStageDef.make({
  init: ($) => ({
    nodes: parseExcalidrawNodes($.props.initialContent),
    saveLabel: "Saved",
  }),
  update: {
    ClickedAddNode: ($) => {
      const idx = $.model.nodes.length

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
        nodes: (prev) => [...prev, nextNode],
        saveLabel: "Unsaved",
      })
    },
    ClickedSave: ($) => {
      const file = $.props.file
      const payload = serializeExcalidrawNodes($.model.nodes, $.props.theme)

      return $.evolve({ saveLabel: "Saving..." }).run(
        SaveBoardFile.make({
          projectId: file.projectId,
          relativePath: file.relativePath,
          content: payload,
        }),
      )
    },
    SucceededSave: ($) => $.evolve({ saveLabel: "Saved" }),
    FailedSave: ($) => $.evolve({ saveLabel: "Save failed" }),
    ClickedAddToComposer: ($) => {
      const rel = $.props.file.relativePath

      return $.emit(
        ExcalidrawStageEvents.AddedToComposer({
          text: `[Architecture Board @${rel}]\nUpdated board diagram — align implementation with these panel boundaries.`,
          attachmentPath: rel,
        }),
      )
    },
  },
  view: (h, model) =>
    h.div
      .attr("data-testid", "stage-excalidraw-view")
      .class("flex min-h-0 flex-1 flex-col")
      .children(
        h.div
          .class("flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/25 px-2.5 py-1.5")
          .children(
            h.div
              .class("flex items-center gap-1.5")
              .children(
                h.button
                  .attrs({ type: "button", "data-testid": "excalidraw-add-node-btn" })
                  .class(buttonClass("outline", "xs"))
                  .on("click", ExcalidrawStageMessage.ClickedAddNode())
                  .children(IconPlusCircle(h), "Add Node"),
                h.button
                  .attrs({ type: "button", "data-testid": "excalidraw-save-btn" })
                  .class(buttonClass("default", "xs"))
                  .on("click", ExcalidrawStageMessage.ClickedSave())
                  .children(IconSave(h), "Save to Artifacts"),
                h.button
                  .attr("type", "button")
                  .class(buttonClass("ghost", "xs"))
                  .on("click", ExcalidrawStageMessage.ClickedAddToComposer())
                  .children(IconMessagePlus(h), "Add to Composer"),
              ),
            Badge(h, model.saveLabel === "Saved" ? "success" : "warning")
              .attr("data-testid", "excalidraw-save-state")
              .children(model.saveLabel),
          ),
        h.div
          .class("relative min-h-0 flex-1 overflow-auto p-4", h.props.theme === "dark" ? "bg-[#111215]" : "bg-white")
          .children(
            h.svg
              .attrs({ viewBox: "0 0 920 560", role: "img", "aria-label": "Architecture board" })
              .class("h-full min-h-[360px] w-full")
              .children(
                model.nodes.map((node) =>
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
      ),
})

export const ExcalidrawStage = ExcalidrawStageNoDeps.pipe(Component.provide(SaveBoardFile.layer))
