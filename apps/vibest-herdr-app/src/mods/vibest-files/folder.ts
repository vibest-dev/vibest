import type { Context } from "gpui-kit"
import { focused, panes, spaces, watchFolder } from "herdr"

import { directory, type Entry, gitMarks, PER_FOLDER, TOTAL } from "./tree.ts"

interface Where {
  readonly key: string
  readonly cwd: string | null
  readonly on: string | null
}

export class Folder {
  where: Where = { key: "", cwd: null, on: null }
  saved = new Map<string, Set<string>>()
  entries = new Map<string, Entry[]>()
  open = new Set<string>()
  pending = new Set<string>()
  marks: Record<string, string> = {}
  watched: string | null = null
  loading = false
  limited = false
  error: string | null = null

  locate(): Where {
    const f = focused()
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null
    if (pane?.mod) return this.where
    const space = spaces().find((s) => s.active)
    const on = space?.machine ?? null
    const cwd = pane?.cwd || f?.cwd || space?.folder || null
    return { key: JSON.stringify([cwd, on, space?.id]), cwd, on }
  }

  moved(): boolean {
    return this.locate().key !== this.where.key
  }

  current(where: Where): boolean {
    return this.where === where && this.locate().key === where.key
  }

  async loadFolder(path: string, where: Where): Promise<void> {
    const entries = await directory(path ? `${where.cwd}/${path}` : where.cwd, where.on)
    if (!this.current(where) || (path && !this.open.has(path))) return
    const used = [...this.entries].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0)
    this.entries.set(
      path,
      entries
        .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)),
    )
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true
  }

  watch(where: Where, cx: Context): void {
    if (where.on || this.watched === where.cwd) return
    this.watched = where.cwd
    cx.spawn(async (spawned) => {
      try {
        while (this.where === where) {
          await watchFolder(where.cwd)
          if (this.current(where)) this.refresh(spawned)
        }
      } catch {
        if (this.where === where) this.watched = null
      }
    })
  }

  refresh(cx: Context): void {
    const next = this.locate()
    if (next.key !== this.where.key) {
      if (this.where.key) this.saved.set(this.where.key, this.open)
      this.where = next
      this.entries = new Map()
      this.open = new Set(this.saved.get(next.key))
      this.pending = new Set()
      this.marks = {}
      this.watched = null
      this.error = null
      this.limited = false
      this.loading = false
    }
    const where = this.where
    if (!where.cwd || this.loading) return
    this.loading = true
    this.limited = false
    cx.spawn(async (spawned) => {
      try {
        for (const path of ["", ...this.open]) {
          if (!this.current(where)) return
          await this.loadFolder(path, where)
        }
        const marks = await gitMarks(where.cwd, where.on)
        if (!this.current(where)) return
        this.marks = marks
        this.error = null
        this.watch(where, spawned)
      } catch (e) {
        if (this.current(where)) this.error = String(e)
      } finally {
        if (this.where === where) this.loading = false
        spawned.notify()
      }
    })
  }

  toggle(path: string, cx: Context): void {
    if (this.open.has(path)) {
      for (const folder of this.open)
        if (folder === path || folder.startsWith(`${path}/`)) {
          this.open.delete(folder)
          this.entries.delete(folder)
        }
    } else {
      this.open.add(path)
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const where = this.where
        this.pending.add(path)
        cx.spawn(async (spawned) => {
          try {
            await this.loadFolder(path, where)
          } catch (e) {
            if (this.current(where)) this.error = String(e)
          } finally {
            if (this.where === where) this.pending.delete(path)
            spawned.notify()
          }
        })
      }
    }
    cx.notify()
  }
}
