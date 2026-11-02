// Compact user messages for the vibest coordinator's interactive Pi TUI.
// Notices for the adapted MIT sources are in THIRD_PARTY_NOTICES.md.
// No unlicensed tripplyons code is included.
import { UserMessageComponent } from "@earendil-works/pi-coding-agent"
import { TuiAltScreen } from "@earendil-works/pi-tui"

type Render = (this: unknown, width: number) => string[]
type Paint = (this: unknown) => void

// One lease per patch of the shared Pi prototypes. It lives on UserMessageComponent.prototype only while our wrappers are
// installed and owned, so overlapping extension instances of this module share one patch. `by` is this module's factory:
// a lease from another module evaluation (after /reload) is never joined.
type Lease = {
  by: typeof compactUserMessages
  owners: Set<object>
  render: Render
  paint: Paint
  renderOriginal: Render
  paintOriginal: Paint
  active: boolean
}

function readLease(proto: object): Lease | undefined {
  const lease = Object.getOwnPropertyDescriptor(proto, "vibestCompactUserMessagesLease")?.value as Lease | undefined
  return lease?.by === compactUserMessages ? lease : undefined
}

function writeLease(proto: object, lease: Lease | undefined) {
  if (lease)
    Object.defineProperty(proto, "vibestCompactUserMessagesLease", {
      value: lease,
      configurable: true,
      enumerable: false,
      writable: false,
    })
  else delete (proto as Record<string, unknown>).vibestCompactUserMessagesLease
}

function restoreRender(child: { render?: (width: number) => string[] }, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(child, "render", descriptor)
  else delete child.render
}

function compact(this: unknown, original: (width: number) => string[], width: number): string[] {
  const ZONE_A = "\x1b]133;A\x07"
  const ZONE_B = "\x1b]133;B\x07"
  const ZONE_C = "\x1b]133;C\x07"
  const INVERTED = ZONE_B + ZONE_C + ZONE_A
  const LEADING = ZONE_A + ZONE_B + ZONE_C
  const children = (this as { children?: unknown[] }).children
  const restores: Array<() => void> = []
  try {
    if (Array.isArray(children)) {
      for (const child of children) {
        if (!child || typeof child !== "object") continue
        const view = child as { paddingY?: unknown; render?: (width: number) => string[] }
        const paddingY = view.paddingY
        if (!Number.isInteger(paddingY) || (paddingY as number) <= 0 || typeof view.render !== "function") continue
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
    if (!Array.isArray(lines) || lines.length !== 1 || typeof lines[0] !== "string" || !lines[0].startsWith(INVERTED))
      return lines
    const copy = lines.slice()
    copy[0] = LEADING + lines[0].slice(INVERTED.length)
    return copy
  } finally {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]!()
  }
}

function isFramePaint(paint: unknown, lease: Lease | undefined, nativePaint: Paint | undefined): paint is Paint {
  if (typeof paint !== "function") return false
  if (lease?.paint === paint || nativePaint === paint) return true
  return paint.toString().includes("renderLayoutFrame")
}

export default function compactUserMessages(pi: {
  on(event: string, handler: (event?: unknown, ctx?: { mode?: string; hasUI?: boolean }) => void): unknown
}) {
  const owner = {}
  // The prototypes' methods as this instance first found them. A later install refuses when they changed.
  let nativeRender: Render | undefined
  let nativePaint: Paint | undefined
  let release: (() => void) | null = null

  function install(): () => void {
    const message = UserMessageComponent?.prototype as { render?: Render } | undefined
    const alt = TuiAltScreen?.prototype as unknown as { doRender?: unknown } | undefined
    const render = message?.render
    const paint = alt?.doRender
    if (!message || !alt || typeof render !== "function") return () => {}
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
        render(this: unknown, width: number) {
          if (!next.active || !framing) return render.call(this, width)
          return compact.call(this, render, width)
        },
        paint(this: unknown) {
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
      // Publish the lease first, so no installed wrapper is ever without an owner.
      writeLease(message, next)
      try {
        message.render = next.render
      } catch (error) {
        writeLease(message, undefined)
        throw error
      }
      try {
        alt.doRender = next.paint
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
      if (alt.doRender === held.paint) alt.doRender = held.paintOriginal
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
