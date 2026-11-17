import type { ExtensionAPI, UserMessageComponent } from "@earendil-works/pi-coding-agent"
import type { TuiAltScreen } from "@earendil-works/pi-tui"
import { Predicate } from "effect"

type Render = (this: UserMessageComponent, width: number) => string[]

type Paint = (this: TuiAltScreen) => void

type Rendered = { render?: Render }

type Lease = {
  by: typeof compactUserMessages
  owners: Set<object>
  render: Render
  paint: Paint
  renderOriginal: Render
  paintOriginal: Paint
  active: boolean
}

function readLease(proto: Rendered): Lease | undefined {
  const lease = Object.getOwnPropertyDescriptor(proto, "vibestCompactUserMessagesLease")?.value as Lease | undefined

  return lease?.by === compactUserMessages ? lease : undefined
}

function writeLease(proto: Rendered, lease: Lease | undefined) {
  if (lease)
    Object.defineProperty(proto, "vibestCompactUserMessagesLease", {
      value: lease,
      configurable: true,
      enumerable: false,
      writable: false,
    })
  else Reflect.deleteProperty(proto, "vibestCompactUserMessagesLease")
}

function restoreRender(child: { render?: (width: number) => string[] }, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(child, "render", descriptor)
  else delete child.render
}

function compact(this: UserMessageComponent, original: Render, width: number): string[] {
  const ZONE_A = "\x1b]133;A\x07"
  const ZONE_B = "\x1b]133;B\x07"
  const ZONE_C = "\x1b]133;C\x07"
  const INVERTED = ZONE_B + ZONE_C + ZONE_A
  const LEADING = ZONE_A + ZONE_B + ZONE_C
  const children = this.children
  const restores: Array<() => void> = []

  try {
    if (Array.isArray(children)) {
      for (const child of children) {
        if (!Predicate.isObjectOrArray(child)) continue
        const view = child as { paddingY?: number; render?: (width: number) => string[] }
        const paddingY = view.paddingY

        if (!Number.isInteger(paddingY) || (paddingY as number) <= 0 || !Predicate.isFunction(view.render)) continue
        const descriptor = Object.getOwnPropertyDescriptor(view, "render")
        const childRender = view.render
        view.render = function (innerWidth: number) {
          const lines = childRender.call(this, innerWidth)

          if (!Array.isArray(lines) || lines.length <= (paddingY as number) * 2) return lines

          return lines.slice(paddingY as number, lines.length - (paddingY as number))
        }

        restores.push(() => restoreRender(view, descriptor))
      }
    }

    const lines = original.call(this, width)

    if (!Array.isArray(lines) || lines.length !== 1 || !Predicate.isString(lines[0]) || !lines[0].startsWith(INVERTED))
      return lines
    const copy = lines.slice()
    copy[0] = LEADING + lines[0].slice(INVERTED.length)

    return copy
  } finally {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]!()
  }
}

function isFramePaint(
  paint: Paint | undefined,
  lease: Lease | undefined,
  nativePaint: Paint | undefined,
): paint is Paint {
  if (!Predicate.isFunction(paint)) return false

  if (lease?.paint === paint || nativePaint === paint) return true

  return paint.toString().includes("renderLayoutFrame")
}

export interface TuiClasses {
  readonly UserMessageComponent: { readonly prototype: Rendered } | undefined
  readonly TuiAltScreen: { readonly prototype: TuiAltScreen } | undefined
}

export default function compactUserMessages(pi: Pick<ExtensionAPI, "on">, classes: TuiClasses) {
  const owner = {}
  let nativeRender: Render | undefined
  let nativePaint: Paint | undefined
  let release: (() => void) | null = null

  function install(): () => void {
    const message = classes.UserMessageComponent?.prototype
    const alt = classes.TuiAltScreen?.prototype
    const render = message?.render
    const paint = alt?.["doRender"]

    if (!message || !alt || !Predicate.isFunction(render)) return () => {}

    let lease = readLease(message)

    if (!isFramePaint(paint, lease, nativePaint)) return () => {}

    if (lease) lease.owners.add(owner)
    else if (
      (nativeRender === undefined || render === nativeRender) &&
      (nativePaint === undefined || paint === nativePaint)
    ) {
      let framing = false

      const next: Lease = {
        by: compactUserMessages,
        owners: new Set([owner]),
        render(this: UserMessageComponent, width: number) {
          if (!next.active || !framing) return render.call(this, width)

          return compact.call(this, render, width)
        },
        paint(this: TuiAltScreen) {
          if (!next.active) return paint.call(this)
          framing = true

          try {
            return paint.call(this)
          } finally {
            framing = false
          }
        },
        renderOriginal: render,
        paintOriginal: paint,
        active: true,
      }

      writeLease(message, next)

      try {
        message.render = next.render
      } catch (error) {
        writeLease(message, undefined)
        throw error
      }

      try {
        alt["doRender"] = next.paint
      } catch (error) {
        message.render = render
        writeLease(message, undefined)
        throw error
      }

      lease = next
    } else return () => {}

    const held = lease
    nativeRender = held.renderOriginal
    nativePaint = held.paintOriginal
    let released = false

    return () => {
      if (released) return
      released = true
      held.owners.delete(owner)

      if (held.owners.size > 0) return
      held.active = false

      if (message.render === held.render) message.render = held.renderOriginal

      if (alt["doRender"] === held.paint) alt["doRender"] = held.paintOriginal

      if (readLease(message) === held) writeLease(message, undefined)
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode !== "tui" || !ctx.hasUI) {
      release?.()
      release = null

      return
    }

    release?.()
    release = install()
  })
  pi.on("session_shutdown", () => {
    release?.()
    release = null
  })
}
