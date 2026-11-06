import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"

type Host = any
type Row = {
  id: string
  name: string
  args?: Host
  parentId?: string
  isError: boolean
  isPartial: boolean
  result?: Host
}
type RowFields = { [K in keyof Row]?: Row[K] | undefined }
type Group = { settled: boolean; expanded: boolean; members: Row[] }
type ToolGroupsApi = {
  on(event: string, handler: (event: Host, ctx: Host) => void): unknown
  registerToolRenderer(resolver: (toolName: string, next: () => Host) => Host): void
}

export default function (pi: ToolGroupsApi) {
  let open: Group | null = null
  let runActive = false
  const groups: Group[] = []
  const byId = new Map<string, Group>()
  const calls = new Map<string, Row>()
  const invalidators = new Map<string, () => void>()
  const expandedById = new Map<string, boolean>()
  let bodyGroup = new WeakMap<object, Group>()
  let replaying = false

  function gutter(width: number, outputPad: unknown) {
    const room = Math.max(1, Math.floor(width) || 1)
    let pad = Math.max(0, Math.floor(Number(outputPad) || 0))
    if (pad * 2 >= room) pad = Math.max(0, Math.floor((room - 1) / 2))
    return { pad, limit: Math.max(1, room - pad * 2) }
  }

  function indent(lines: string[], pad: number) {
    if (!pad) return lines
    const prefix = " ".repeat(pad)
    return lines.map((line) => prefix + line)
  }

  function frameLines(renderers: Host, component: Host, width: number, outputPad: unknown): string[] {
    if (renderers?.renderShell === "self") return component.render(width)
    const { pad, limit } = gutter(width, outputPad)
    return indent(component.render(limit), pad)
  }

  function frameComponent(renderers: Host, component: Host, outputPad: unknown) {
    if (renderers?.renderShell === "self") return component
    return {
      invalidate() {
        component.invalidate?.()
      },
      render(width: number) {
        return frameLines(renderers, component, width, outputPad)
      },
    }
  }

  function wrapText(text: unknown, width: number) {
    return wrapTextWithAnsi(String(text ?? ""), Math.max(1, width || 1))
  }

  function oneLine(text: unknown, limit: number) {
    const flat = String(text ?? "")
      .replace(/\s+/g, " ")
      .trim()
    if (!flat) return ""
    if (flat.length <= limit) return flat
    return flat.slice(0, Math.max(1, limit - 1)) + "\u2026"
  }

  function primaryArg(name: string, args: Host) {
    if (args === undefined || args === null) return ""
    if (typeof args !== "object" || Array.isArray(args))
      return oneLine(typeof args === "string" ? args : JSON.stringify(args), 40)
    const preferred = (
      {
        read: ["path", "file_path"],
        write: ["path", "file_path"],
        edit: ["path", "file_path"],
        ls: ["path"],
        bash: ["command"],
        powershell: ["command"],
        grep: ["pattern"],
        find: ["pattern", "path"],
        tool_search: ["query"],
      } as Record<string, string[]>
    )[name] || ["path", "file_path", "command", "query", "pattern", "url"]
    const sensitive = /token|secret|password|authorization|credential|api[_-]?key/i
    for (const key of preferred) {
      if (sensitive.test(key)) continue
      const value = args[key]
      if (typeof value === "string" && value) return oneLine(value, 40)
    }
    for (const [key, value] of Object.entries(args)) {
      if (sensitive.test(key) || key === "script" || key === "content" || key === "edits") continue
      if (typeof value === "string" && value) return oneLine(value, 40)
    }
    return ""
  }

  function resultText(result: Host) {
    const texts: string[] = []
    if (Array.isArray(result?.content)) {
      for (const part of result.content) if (part?.type === "text" && part.text) texts.push(part.text)
    }
    const line =
      texts
        .join("\n")
        .split("\n")
        .find((item) => item.trim()) ?? ""
    return line.trim()
  }

  function compactText(member: Row, limit: number) {
    const extra = calls.get(member.id)
    const name = member.name || extra?.name || member.id
    const arg = primaryArg(name, member.args ?? extra?.args)
    const isError = member.isError || extra?.isError
    const text = resultText(member.result ?? extra?.result)
    const summary = isError ? (text ? "Error \u00b7 " + oneLine(text, 40) : "Error") : oneLine(text, 40)
    let line = arg ? name + " " + arg : name
    if (summary) line += " \u00b7 " + summary
    return wrapTextWithAnsi(line, limit)
  }

  function nestedLines(parentId: string, limit: number) {
    const lines: string[] = []
    for (const call of calls.values()) {
      if (call.parentId !== parentId || byId.has(call.id)) continue
      lines.push(...compactText(call, limit))
    }
    return lines
  }

  function showNative(ctx: Host, group: Group | undefined) {
    if (ctx?.expanded !== true || !group) return false
    if (group.members.length < 2) return true
    if (group.members[0]?.id !== ctx.toolCallId) return true
    return group.members.every((member) => expandedById.get(member.id) === true)
  }

  function plainCall(name: string, args: unknown, width: number) {
    const lines = wrapText(name, width)
    if (args && typeof args === "object" && !Array.isArray(args)) {
      for (const [key, value] of Object.entries(args)) {
        const shown = typeof value === "string" ? value : JSON.stringify(value)
        lines.push(...wrapText(key + ": " + shown, width))
      }
    } else if (args !== undefined) {
      lines.push(...wrapText(JSON.stringify(args), width))
    }
    return lines
  }

  function plainResult(result: Host, isError: unknown, width: number) {
    const texts: string[] = []
    if (Array.isArray(result?.content)) {
      for (const part of result.content) if (part?.type === "text" && part.text) texts.push(part.text)
    }
    const lines: string[] = []
    if (isError) lines.push(...wrapText("Error", width))
    lines.push(...wrapText(texts.join("\n"), width))
    return lines.filter((line) => line !== "")
  }

  function reset() {
    open = null
    groups.length = 0
    byId.clear()
    calls.clear()
    expandedById.clear()
    bodyGroup = new WeakMap()
  }

  function finish(group: Group | null) {
    if (!group || group.settled) return
    group.settled = true
    for (const member of group.members) member.isPartial = false
    ping(group.members[0]?.id)
  }

  function newGroup() {
    open = { settled: false, expanded: false, members: [] }
    groups.push(open)
    return open
  }

  function place(id: string, name: string | undefined, group: Group, args?: unknown) {
    const current = byId.get(id)
    if (current === group) {
      const row = group.members.find((item) => item.id === id)
      if (row && name) row.name = name
      if (row && args !== undefined) row.args = args
      return group
    }
    if (current) {
      const oldAnchor = current.members[0]
      current.members = current.members.filter((item) => item.id !== id)
      if (oldAnchor && oldAnchor.id !== id) ping(oldAnchor.id)
    }
    const row: Row = { id, name: name || id, isError: false, isPartial: false, args }
    group.members.push(row)
    byId.set(id, group)
    const anchor = group.members[0]
    if (anchor !== row) ping(anchor!.id)
    return group
  }

  function ping(id: string | undefined) {
    if (!replaying && id) invalidators.get(id)?.()
  }

  function note(message: Host) {
    if (!message || typeof message !== "object") return
    if (message.role === "user" || (message.role === "custom" && message.display)) {
      finish(open)
      open = null
      return
    }
    if (message.role === "toolResult") {
      const nested = message.nestedCalls?.calls
      if (!Array.isArray(nested)) return
      for (const call of nested) {
        if (!call?.id || calls.has(call.id)) continue
        remember(call.id, {
          name: call.name,
          args: call.arguments,
          parentId: message.toolCallId,
          isError: call.status === "error",
          isPartial: call.status === "unfinished",
        })
      }
      return
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) return
    const toolCalls = message.content.filter((part: Host) => part?.type === "toolCall" && part.id)
    const hasBody = message.content.some((part: Host) => part?.type === "text" && String(part.text ?? "").trim())
    if (!hasBody) {
      for (const call of toolCalls)
        if (!byId.has(call.id)) place(call.id, call.name, open ?? newGroup(), call.arguments)
      return
    }
    let group = bodyGroup.get(message)
    if (!group) {
      if (open) finish(open)
      group = newGroup()
      bodyGroup.set(message, group)
    }
    for (const call of toolCalls) place(call.id, call.name, group, call.arguments)
  }

  function remember(id: string, fields: RowFields) {
    let row = calls.get(id)
    if (!row) {
      row = { id, name: "", isError: false, isPartial: false }
      calls.set(id, row)
    }
    if (fields.name) row.name = fields.name
    if (fields.args !== undefined) row.args = fields.args
    if (fields.parentId) row.parentId = fields.parentId
    if (fields.isError !== undefined) row.isError = fields.isError
    if (fields.isPartial !== undefined) row.isPartial = fields.isPartial
    if (fields.result !== undefined) row.result = fields.result
    const owner = byId.get(row.parentId || id)
    ping(owner?.members[0]?.id)
    return row
  }

  function pathPart(verb: string, one: string, many: string, ops: RowFields[]) {
    if (!ops.length) return
    const paths: string[] = []
    for (const op of ops) {
      const path = op.args && typeof op.args === "object" ? (op.args.path ?? op.args.file_path) : undefined
      if (typeof path !== "string" || !path) return verb + " " + ops.length
      paths.push(path)
    }
    const count = new Set(paths).size
    return verb + " " + count + " " + (count === 1 ? one : many)
  }

  function times(n: number, one: string, many: string) {
    return "Ran " + n + " " + (n === 1 ? one : many)
  }

  function summarize(group: Group): string[] {
    const seen = new Map<string, RowFields>()
    for (const member of group.members) {
      const extra = calls.get(member.id)
      seen.set(member.id, {
        name: member.name || extra?.name,
        args: member.args ?? extra?.args,
        isError: member.isError || extra?.isError,
        isPartial: member.isPartial || extra?.isPartial,
      })
    }
    for (const call of calls.values()) {
      if (!call.parentId || !seen.has(call.parentId) || seen.has(call.id)) continue
      seen.set(call.id, call)
    }
    const all = [...seen.values()]
    const named = (name: string) => all.filter((item) => item.name === name)
    const parts: string[] = []
    const code = named("codemode")
    if (code.length) parts.push("Ran " + code.length + " codemode")
    const read = pathPart("Read", "file", "files", named("read"))
    if (read) parts.push(read)
    const write = pathPart("Wrote", "file", "files", named("write"))
    if (write) parts.push(write)
    const edit = pathPart("Edited", "file", "files", named("edit"))
    if (edit) parts.push(edit)
    const shell = named("bash").length + named("powershell").length
    if (shell) parts.push(times(shell, "shell command", "shell commands"))
    const grep = named("grep").length
    if (grep) parts.push(times(grep, "content search", "content searches"))
    const find = named("find").length
    if (find) parts.push(times(find, "file search", "file searches"))
    const listed = pathPart("Listed", "directory", "directories", named("ls"))
    if (listed) parts.push(listed)
    const search = named("tool_search").length
    if (search) parts.push(times(search, "tool search", "tool searches"))
    const known = new Set([
      "codemode",
      "read",
      "write",
      "edit",
      "bash",
      "powershell",
      "grep",
      "find",
      "ls",
      "tool_search",
    ])
    const other = all.filter((item) => item.name && !known.has(item.name)).length
    if (other) parts.push(times(other, "other tool call", "other tool calls"))
    const failed = all.filter((item) => item.isError).length
    if (failed) parts.push(failed + " failed")
    return parts.length ? parts : [group.members.length + " tools"]
  }

  function callPath(args: Host) {
    const path = args && typeof args === "object" ? (args.path ?? args.file_path) : undefined
    return typeof path === "string" && path ? path : undefined
  }

  function activity(call: RowFields) {
    const path = callPath(call.args)
    if (call.name === "read") return path ? "Reading " + path + "\u2026" : "Reading\u2026"
    if (call.name === "write") return path ? "Writing " + path + "\u2026" : "Writing\u2026"
    if (call.name === "edit") return path ? "Editing " + path + "\u2026" : "Editing\u2026"
    if (call.name === "ls") return path ? "Listing " + path + "\u2026" : "Listing\u2026"
    if (call.name) return "Running " + call.name + "\u2026"
    return "Working\u2026"
  }

  function belongs(call: Row | undefined, memberIds: Set<string>) {
    let current = call
    const seen = new Set<string>()
    while (current && !seen.has(current.id)) {
      if (memberIds.has(current.id)) return true
      seen.add(current.id)
      current = current.parentId ? calls.get(current.parentId) : undefined
    }
    return false
  }

  function header(group: Group): string[] {
    if (!runActive || group.settled) return summarize(group)
    const memberIds = new Set(group.members.map((member) => member.id))
    const partial: Row[] = []
    for (const member of group.members) {
      const extra = calls.get(member.id)
      if (member.isPartial || extra?.isPartial) partial.push(Object.assign({ id: member.id }, member, extra || {}))
    }
    for (const call of calls.values()) {
      if (!call.isPartial || partial.some((item) => item.id === call.id)) continue
      if (belongs(call, memberIds)) partial.push(call)
    }
    const covered = new Set<string>()
    for (const call of partial) {
      let parent = call.parentId
      while (parent) {
        covered.add(parent)
        parent = calls.get(parent)?.parentId
      }
    }
    const parts = partial.filter((call) => !covered.has(call.id)).map(activity)
    if (!parts.length) parts.push("Working\u2026")
    const failed = summarize(group).filter((part) => part.endsWith(" failed"))
    return parts.concat(failed)
  }

  function fit(parts: string[], width: number) {
    const limit = Math.max(1, width || 1)
    const lines: string[] = []
    let line = ""
    for (const part of parts) {
      const piece = truncateToWidth(part, limit, "")
      const next = line ? line + " \u00b7 " + piece : piece
      if (line && visibleWidth(next) > limit) {
        lines.push(line)
        line = piece
      } else {
        line = next
      }
    }
    if (line) lines.push(line)
    return lines
  }

  function visibleEntries(ctx: Host) {
    const build = ctx?.sessionManager?.buildContextEntries
    if (typeof build !== "function") return undefined
    const entries = build.call(ctx.sessionManager)
    return Array.isArray(entries) ? entries : undefined
  }

  function replay(ctx: Host) {
    const entries = visibleEntries(ctx)
    if (!entries) return
    replaying = true
    reset()
    for (const entry of entries) {
      if (entry?.type === "message") note(entry.message)
      else if (entry?.type === "custom_message") note({ role: "custom", display: entry.display })
    }
    replaying = false
    for (const id of invalidators.keys()) if (!byId.has(id)) invalidators.delete(id)
    for (const invalidate of invalidators.values()) invalidate()
  }

  function stopRun() {
    runActive = false
    for (const call of calls.values()) call.isPartial = false
    for (const group of groups) for (const member of group.members) member.isPartial = false
    finish(open)
    for (const invalidate of invalidators.values()) invalidate()
  }

  let unwatch: (() => void) | null = null
  function watch(manager: Host) {
    unwatch?.()
    unwatch = null
    const original = manager?.appendCustomMessageEntry
    if (typeof original !== "function") return
    const own = Object.getOwnPropertyDescriptor(manager, "appendCustomMessageEntry")
    let active = true
    const wrapper = function (this: unknown, ...args: unknown[]) {
      const id = original.apply(this, args)
      if (active) note({ role: "custom", display: args[2] })
      return id
    }
    try {
      manager.appendCustomMessageEntry = wrapper
    } catch {
      return
    }
    unwatch = () => {
      active = false
      if (manager.appendCustomMessageEntry !== wrapper) return
      if (own) Object.defineProperty(manager, "appendCustomMessageEntry", own)
      else delete manager.appendCustomMessageEntry
    }
  }

  pi.on("session_start", (_event, ctx) => {
    runActive = false
    watch(ctx?.sessionManager)
    replay(ctx)
  })
  pi.on("session_shutdown", () => {
    unwatch?.()
    unwatch = null
  })
  pi.on("session_compact", (_event, ctx) => replay(ctx))
  pi.on("session_tree", (_event, ctx) => replay(ctx))
  pi.on("agent_start", () => {
    runActive = true
  })
  pi.on("agent_end", () => stopRun())
  pi.on("message_start", (event) => note(event?.message))
  pi.on("message_update", (event) => note(event?.message))
  pi.on("tool_execution_start", (event) => {
    if (!event?.toolCallId) return
    runActive = true
    remember(event.toolCallId, {
      name: event.toolName,
      args: event.args,
      parentId: event.parentToolCallId,
      isPartial: true,
    })
  })
  pi.on("tool_execution_end", (event) => {
    if (!event?.toolCallId) return
    remember(event.toolCallId, {
      name: event.toolName,
      args: event.args,
      parentId: event.parentToolCallId,
      isError: event.isError === true,
      isPartial: false,
      result: event.result,
    })
  })

  pi.registerToolRenderer((toolName, next) => {
    const later = next()
    if (later?.isVibestToolGroups === true) return later
    return {
      isVibestToolGroups: true,
      renderShell: "self",
      renderCall(args: unknown, theme: Host, ctx: Host) {
        if (ctx?.toolCallId) expandedById.set(ctx.toolCallId, ctx.expanded === true)
        if (ctx?.invalidate) invalidators.set(ctx.toolCallId, ctx.invalidate)
        let group = byId.get(ctx.toolCallId)
        if (!group) group = place(ctx.toolCallId, toolName, open ?? newGroup(), args)
        const row = group.members.find((item) => item.id === ctx.toolCallId)
        if (row) {
          row.name = toolName
          if (args !== undefined) row.args = args
        }
        const renderers = (() => {
          try {
            return next()
          } catch {
            return undefined
          }
        })()
        let native: Host
        if (renderers?.renderCall) {
          try {
            native = renderers.renderCall(args, theme, {
              ...ctx,
              expanded: true,
              lastComponent: ctx.lastComponent?.native,
            })
          } catch {
            native = undefined
          }
        }
        const body = native
          ? frameComponent(renderers, native, ctx.outputPad)
          : {
              render(innerWidth: number) {
                const { pad, limit } = gutter(innerWidth, ctx.outputPad)
                return indent(plainCall(toolName, args, limit), pad)
              },
            }
        return {
          native,
          invalidate() {
            native?.invalidate?.()
          },
          render(width: number) {
            const current = byId.get(ctx.toolCallId)
            if (!current) return []
            const isAnchor = current.members[0]?.id === ctx.toolCallId
            if (isAnchor && ctx.expanded !== current.expanded) {
              current.expanded = ctx.expanded
              const ids = current.members.map((member) => member.id)
              queueMicrotask(() => {
                for (const id of ids) if (id !== ctx.toolCallId) invalidators.get(id)?.()
              })
            }
            const { pad, limit } = gutter(width, ctx.outputPad)
            const paint = (line: string) => (typeof theme?.fg === "function" ? theme.fg("muted", line) : line)
            const title = indent(fit(header(current), limit).map(paint), pad)
            if (!current.expanded) return isAnchor ? title : []
            if (showNative(ctx, current)) return isAnchor ? [...title, ...body.render(width)] : body.render(width)
            const row = current.members.find((item) => item.id === ctx.toolCallId)
            const lines = indent(compactText(row!, limit), pad)
            if (isAnchor) lines.unshift(...title)
            lines.push(...indent(nestedLines(ctx.toolCallId, limit), pad))
            return lines
          },
        }
      },
      renderResult(result: Host, options: Host, theme: unknown, ctx: Host) {
        if (ctx?.toolCallId) expandedById.set(ctx.toolCallId, ctx.expanded === true)
        const group = byId.get(ctx.toolCallId) ?? place(ctx.toolCallId, toolName, open ?? newGroup())
        const row = group.members.find((item) => item.id === ctx.toolCallId)!
        const changed = row.result !== result || row.isError !== ctx.isError || row.isPartial !== ctx.isPartial
        row.result = result
        row.isError = ctx.isError
        row.isPartial = ctx.isPartial
        if (row !== group.members[0] && changed) ping(group.members[0]?.id)
        const renderers = (() => {
          try {
            return next()
          } catch {
            return undefined
          }
        })()
        let native: Host
        if (renderers?.renderResult) {
          try {
            native = renderers.renderResult(result, { ...options, expanded: true }, theme, {
              ...ctx,
              lastComponent: ctx.lastComponent?.native,
            })
          } catch {
            native = undefined
          }
        }
        const body = native
          ? frameComponent(renderers, native, ctx.outputPad)
          : {
              render(innerWidth: number) {
                const { pad, limit } = gutter(innerWidth, ctx.outputPad)
                return indent(plainResult(result, ctx.isError, limit), pad)
              },
            }
        return {
          native,
          invalidate() {
            native?.invalidate?.()
          },
          render(width: number) {
            const current = byId.get(ctx.toolCallId)
            if (!current?.expanded || !showNative(ctx, current)) return []
            return body.render(width)
          },
        }
      },
    }
  })
}
