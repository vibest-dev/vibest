import { Component, Mount } from "@effect/ui"
import { WTerm } from "@wterm/dom"
import { Effect, Option, Queue, Schema, Stream } from "effect"
import mermaid from "mermaid"

import { HoverTargetSchema, ThemeModeSchema } from "../domain/WebHub.ts"

const BridgeMsgSchema = Schema.Union([
  Schema.Struct({ source: Schema.Literal("vibest-web-bridge"), type: Schema.Literal("bridge-ready") }),
  Schema.Struct({
    source: Schema.Literal("vibest-web-bridge"),
    type: Schema.Literal("hover-element"),
    target: Schema.NullOr(HoverTargetSchema),
  }),
  Schema.Struct({
    source: Schema.Literal("vibest-web-bridge"),
    type: Schema.Literal("picked-element"),
    target: Schema.NullOr(HoverTargetSchema),
  }),
])

const decodeBridgeMsg = Schema.decodeUnknownOption(BridgeMsgSchema)

export const RenderSafeHtml = Mount.make(
  "RenderSafeHtml",
  { args: { html: Schema.String } },
  (node: HTMLDivElement, _args, changes) =>
    Stream.runForEach(changes, ({ html }) =>
      Effect.sync(() => {
        node.innerHTML = html
      }),
    ).pipe(Effect.as(Component.noop)),
)

export const RenderMermaid = Mount.make(
  "RenderMermaid",
  {
    args: {
      chart: Schema.String,
      index: Schema.Number,
      theme: ThemeModeSchema,
    },
  },
  (node: HTMLDivElement, _args, changes) =>
    Stream.runForEach(changes, ({ chart, index, theme }) =>
      Effect.tryPromise({
        try: async () => {
          mermaid.initialize({
            startOnLoad: false,
            theme: theme === "dark" ? "dark" : "default",
            securityLevel: "strict",
            fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
          })
          const diagramId = `vb-mermaid-${index}-${Date.now().toString(36)}`
          const res = await mermaid.render(diagramId, chart)
          node.innerHTML = res.svg
        },
        catch: () => undefined,
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            node.textContent = chart
          }),
        ),
      ),
    ).pipe(Effect.as(Component.noop)),
)

export const AttachWterm = Mount.makeStream(
  "AttachWterm",
  {
    args: {
      content: Schema.String,
      compact: Schema.Boolean,
    },
  },
  (node: HTMLDivElement, initialArgs, changes) =>
    Stream.callback<boolean>(
      Effect.fnUntraced(function* (queue) {
        const term = yield* Effect.acquireRelease(
          Effect.sync(() => {
            node.innerHTML = ""

            return new WTerm(node, {
              cols: initialArgs.compact ? 64 : 104,
              rows: initialArgs.compact ? 11 : 28,
              autoResize: true,
              renderer: "dom",
              scrollbackLines: 400,
              cursorBlink: false,
            })
          }),
          (instance) =>
            Effect.sync(() => {
              instance.destroy()
            }),
        )

        const initialized = yield* Effect.tryPromise({
          try: () => term.init().then(() => true),
          catch: () => false,
        }).pipe(Effect.catch(() => Effect.succeed(false)))

        if (!initialized) {
          Queue.offerUnsafe(queue, false)

          return
        }

        Queue.offerUnsafe(queue, true)

        yield* Stream.runForEach(changes, ({ content }) =>
          Effect.sync(() => {
            term.write("\x1b[2J\x1b[H")
            term.write(content.replace(/\r?\n/g, "\r\n"))
          }),
        ).pipe(Effect.forkScoped)
      }),
    ),
)

export const SyncThemeClass = Mount.make(
  "SyncThemeClass",
  { args: { theme: ThemeModeSchema } },
  (_node: HTMLDivElement, _args, changes) =>
    Stream.runForEach(changes, ({ theme }) =>
      Effect.sync(() => {
        if (typeof document === "undefined") return
        document.documentElement.classList.toggle("dark", theme === "dark")
      }),
    ).pipe(Effect.as(Component.noop)),
)

export const SyncTextareaHeight = Mount.make(
  "SyncTextareaHeight",
  { args: { text: Schema.String } },
  (node: HTMLTextAreaElement, _args, changes) =>
    Stream.runForEach(changes, () =>
      Effect.sync(() => {
        node.style.height = "auto"
        node.style.height = `${Math.min(176, Math.max(44, node.scrollHeight))}px`
      }),
    ).pipe(Effect.as(Component.noop)),
)

export const HtmlPreviewEventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("hover"), target: Schema.NullOr(HoverTargetSchema) }),
  Schema.Struct({ kind: Schema.Literal("picked"), target: HoverTargetSchema }),
])

export type HtmlPreviewEvent = typeof HtmlPreviewEventSchema.Type

export const AttachHtmlPreviewBridge = Mount.makeStream(
  "AttachHtmlPreviewBridge",
  {
    args: {
      mode: Schema.Literals(["interact", "pick", "circle", "box"]),
      inspectX: Schema.NullOr(Schema.Number),
      inspectY: Schema.NullOr(Schema.Number),
      pickX: Schema.NullOr(Schema.Number),
      pickY: Schema.NullOr(Schema.Number),
      pickSeq: Schema.Number,
    },
  },
  (iframe: HTMLIFrameElement, initialArgs, changes) =>
    Stream.callback<HtmlPreviewEvent>(
      Effect.fnUntraced(function* (queue) {
        const current = { mode: initialArgs.mode, lastPickSeq: initialArgs.pickSeq }

        const onMessage = (ev: MessageEvent) => {
          if (ev.source !== iframe.contentWindow) return
          const decoded = decodeBridgeMsg(ev.data)

          if (Option.isNone(decoded)) return
          const msg = decoded.value

          if (msg.type === "hover-element" && current.mode === "pick") {
            Queue.offerUnsafe(queue, { kind: "hover", target: msg.target })
          } else if (msg.type === "picked-element" && current.mode === "pick" && msg.target !== null) {
            Queue.offerUnsafe(queue, { kind: "picked", target: msg.target })
          }
        }

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            window.addEventListener("message", onMessage)
          }),
          () =>
            Effect.sync(() => {
              window.removeEventListener("message", onMessage)
            }),
        )

        yield* Stream.runForEach(changes, (args) =>
          Effect.sync(() => {
            current.mode = args.mode

            if (args.mode === "pick" && args.inspectX !== null && args.inspectY !== null) {
              iframe.contentWindow?.postMessage(
                { source: "vibest-web-parent", type: "inspect-point", x: args.inspectX, y: args.inspectY },
                "*",
              )
            }

            if (
              args.mode === "pick" &&
              args.pickSeq !== current.lastPickSeq &&
              args.pickX !== null &&
              args.pickY !== null
            ) {
              current.lastPickSeq = args.pickSeq
              iframe.contentWindow?.postMessage(
                { source: "vibest-web-parent", type: "pick-point", x: args.pickX, y: args.pickY },
                "*",
              )
            }
          }),
        ).pipe(Effect.forkScoped)
      }),
    ),
)

export const HtmlOverlayPointerEventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("move"), x: Schema.Number, y: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("down"), x: Schema.Number, y: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("up"), x: Schema.Number, y: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("click"), x: Schema.Number, y: Schema.Number }),
])

export type HtmlOverlayPointerEvent = typeof HtmlOverlayPointerEventSchema.Type

export const TrackHtmlOverlay = Mount.makeStream("TrackHtmlOverlay", {}, (node: HTMLDivElement) =>
  Stream.callback<HtmlOverlayPointerEvent>(
    Effect.fnUntraced(function* (queue) {
      const localPoint = (ev: MouseEvent) => {
        const bounds = node.getBoundingClientRect()

        return {
          x: Math.max(0, Math.min(bounds.width, ev.clientX - bounds.left)),
          y: Math.max(0, Math.min(bounds.height, ev.clientY - bounds.top)),
        }
      }

      const onMove = (ev: MouseEvent) => Queue.offerUnsafe(queue, { kind: "move", ...localPoint(ev) })
      const onDown = (ev: MouseEvent) => Queue.offerUnsafe(queue, { kind: "down", ...localPoint(ev) })
      const onUp = (ev: MouseEvent) => Queue.offerUnsafe(queue, { kind: "up", ...localPoint(ev) })
      const onClick = (ev: MouseEvent) => Queue.offerUnsafe(queue, { kind: "click", ...localPoint(ev) })

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          node.addEventListener("mousemove", onMove)
          node.addEventListener("mousedown", onDown)
          node.addEventListener("mouseup", onUp)
          node.addEventListener("click", onClick)
        }),
        () =>
          Effect.sync(() => {
            node.removeEventListener("mousemove", onMove)
            node.removeEventListener("mousedown", onDown)
            node.removeEventListener("mouseup", onUp)
            node.removeEventListener("click", onClick)
          }),
      )
    }),
  ),
)

export const CaptureMarkdownSelection = Mount.makeStream("CaptureMarkdownSelection", {}, (node: HTMLDivElement) =>
  Stream.callback<string>(
    Effect.fnUntraced(function* (queue) {
      const onMouseUp = () => {
        const sel = window.getSelection()

        if (!sel || sel.isCollapsed) return
        const text = sel.toString().replace(/\s+/g, " ").trim()

        if (text.length < 3) return

        if (sel.anchorNode && node.contains(sel.anchorNode)) {
          Queue.offerUnsafe(queue, text.slice(0, 200))
        }
      }

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          node.addEventListener("mouseup", onMouseUp)
        }),
        () =>
          Effect.sync(() => {
            node.removeEventListener("mouseup", onMouseUp)
          }),
      )
    }),
  ),
)
