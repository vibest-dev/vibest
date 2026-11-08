import { h_flex, v_flex } from "gpui-base"
import { div, View } from "gpui-kit"
import { appHome, exec, panes, run, terminals, theme } from "herdr"

import {
  cliArgv,
  coreTerminals,
  focusOf,
  groupSessions,
  matchTerminal,
  modelPanes,
  parseDaemonRunning,
  parseSessions,
  REFRESH_MS,
  rowTitle,
  type CoreTerminal,
  type ModelPane,
  projectHeading,
  type SessionRow,
  statusText,
} from "./sessions.ts"

const clip = (value: string): string => {
  const trimmed = value.trim()
  return (trimmed === "" ? "vibest failed" : trimmed).slice(0, 180)
}

export default class VibestSessions extends View {
  sessions!: readonly SessionRow[]
  note!: string
  refreshing!: boolean

  init(_props: unknown, cx: Cx): void {
    this.sessions = []
    this.note = "Loading…"
    this.refreshing = false
    const pull = (current: Cx) => {
      current.spawn(async (spawned) => {
        await this.refresh(spawned)
      })
    }
    cx.timer.every(REFRESH_MS, pull)
    pull(cx)
  }

  async refresh(cx: Cx): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      const cwd = appHome()
      const status = await exec("env", cliArgv("status"), { cwd })
      if (status.code !== 0) this.fail(clip(status.stderr || status.stdout || "vibest status failed"))
      else {
        const running = parseDaemonRunning(status.stdout)
        if (running === undefined) this.fail("vibest status was not understood")
        else if (!running) this.fail("vibestd is not running")
        else {
          const listed = await exec("env", cliArgv("ls"), { cwd })
          if (listed.code !== 0) this.fail(clip(listed.stderr || listed.stdout || "vibest ls failed"))
          else {
            const sessions = parseSessions(listed.stdout)
            if (sessions === undefined) this.fail("vibest ls was not understood")
            else {
              this.sessions = sessions
              this.note = sessions.length === 0 ? "No live sessions" : ""
            }
          }
        }
      }
      cx.notify()
    } catch (error) {
      this.fail(clip(error instanceof Error ? error.message : "vibest could not be run"))
      cx.notify()
    } finally {
      this.refreshing = false
    }
  }

  fail(note: string): void {
    this.note = note
    this.sessions = []
  }

  sessionRow(
    colors: Record<string, string>,
    session: SessionRow,
    found: readonly CoreTerminal[],
    open: readonly ModelPane[],
  ): Chain {
    const terminal = matchTerminal(session, found)
    const focus = terminal === undefined ? undefined : focusOf(terminal.address, open)
    const row = h_flex()
      .id(`session-${session.id}`)
      .gap(6)
      .px(2)
      .py(2)
      .items_center()
      .rounded(4)
      .child(
        div()
          .w(8)
          .flex_none()
          .text_color(colors[session.status] ?? colors.muted ?? "")
          .child("●"),
      )
      .child(
        div()
          .flex_1()
          .truncate()
          .text_color(colors.foreground ?? "")
          .child(rowTitle(session)),
      )
      .child(
        div()
          .flex_none()
          .text_color(colors.dim ?? "")
          .child(`${session.harness} ${statusText(session)}`),
      )
      .child(
        div()
          .flex_none()
          .text_color(colors.dim ?? "")
          .child(session.id.slice(0, 8)),
      )
    if (focus === undefined)
      return row.child(
        div()
          .flex_none()
          .text_color(colors.dim ?? "")
          .child("not in this window"),
      )
    const action = focus
    return row
      .cursor_pointer()
      .hover((el) => el.bg(colors.hover ?? ""))
      .on_click(() => {
        run(action.command, action.args)
      })
  }

  render(_cx: Cx): Chain {
    const colors = theme()
    const found = coreTerminals(terminals())
    const open = modelPanes(panes())
    const rows = groupSessions(this.sessions).flatMap((group) => [
      div()
        .id(`project-${group.projectId}`)
        .truncate()
        .text_color(colors.dim ?? "")
        .child(projectHeading(group.projectId, group.label)),
      ...group.sessions.map((session) => this.sessionRow(colors, session, found, open)),
    ])
    return v_flex()
      .id("vibest-sessions")
      .size_full()
      .bg(colors.surface ?? "")
      .p(10)
      .gap(6)
      .text_size(12)
      .overflow_y_scrollbar()
      .child(
        div()
          .font_semibold()
          .text_color(colors.foreground ?? "")
          .child("Vibest"),
      )
      .when(this.note !== "", (el) =>
        el.child(
          div()
            .text_color(colors.muted ?? "")
            .child(this.note),
        ),
      )
      .children(rows)
  }
}
