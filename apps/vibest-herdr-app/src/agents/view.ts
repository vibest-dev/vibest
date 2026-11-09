import { h_flex, v_flex } from "gpui-base"
import { div } from "gpui-kit"
import { appHome, exec, type Theme } from "herdr"

import { commandNote, LS_ARGV, parseSessions, type SessionRow } from "./cli.ts"
import {
  closePull,
  completePull,
  groupSessions,
  idlePull,
  projectHeading,
  type Pull,
  requestPull,
  rowTitle,
  rowTooltip,
  sessionStatus,
  shortId,
  snapshotNote,
} from "./model.ts"

export class AgentList {
  sessions: readonly SessionRow[] = []
  note = "Reading vibestd…"
  asOf = ""
  pull: Pull = idlePull()

  constructor(cx: Cx) {
    this.request(cx)
  }

  close(): void {
    this.pull = closePull(this.pull)
  }

  request(cx: Cx): void {
    const next = requestPull(this.pull)
    const started = !this.pull.running && next.running
    this.pull = next
    if (!started) return
    const token = next.token
    cx.spawn(async (spawned) => {
      await this.read(spawned, token)
    })
  }

  async read(cx: Cx, token: number): Promise<void> {
    let note = ""
    let asOf = ""
    let sessions: readonly SessionRow[] = []
    try {
      const listed = await exec("env", [...LS_ARGV], { cwd: appHome() })
      if (listed.code !== 0) note = commandNote(listed, "vibest ls failed")
      else {
        const parsed = parseSessions(listed.stdout)
        if (parsed === undefined) note = "vibest ls was not understood"
        else {
          sessions = parsed
          asOf = new Date().toISOString().slice(11, 19)
          note = parsed.length === 0 ? "No live sessions." : ""
        }
      }
    } catch (error) {
      note = commandNote(
        { code: 1, stdout: "", stderr: error instanceof Error ? error.message : "vibest could not be run" },
        "vibest could not be run",
      )
    }
    const done = completePull(this.pull, token)
    this.pull = done.pull
    if (done.apply) {
      this.sessions = sessions
      this.note = note
      this.asOf = asOf
      cx.notify()
    }
    if (this.pull.running) {
      const follow = this.pull.token
      cx.spawn(async (spawned) => {
        await this.read(spawned, follow)
      })
    }
  }

  sessionRow(colors: Theme, session: SessionRow): Chain {
    return h_flex()
      .id(`session-${session.id}`)
      .gap(8)
      .px(2)
      .py(2)
      .items_center()
      .rounded(4)
      .tooltip(rowTooltip(session))
      .child(div().flex_1().min_w(0).truncate().text_color(colors.foreground).child(rowTitle(session)))
      .child(div().flex_none().text_color(colors.muted).child(sessionStatus(session)))
      .child(div().flex_none().text_color(colors.dim).child(shortId(session)))
  }

  render(colors: Theme): Chain {
    const rows = groupSessions(this.sessions).flatMap((group) => [
      div()
        .id(`project-${group.projectId}`)
        .truncate()
        .text_color(colors.dim)
        .child(projectHeading(group.projectId, group.label)),
      ...group.sessions.map((session) => this.sessionRow(colors, session)),
    ])
    return v_flex()
      .id("agents")
      .size_full()
      .bg(colors.surface)
      .p(10)
      .gap(6)
      .text_size(12)
      .overflow_y_scrollbar()
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().font_semibold().text_color(colors.foreground).child("Agents"))
          .child(div().flex_1())
          .child(
            div()
              .id("agents-refresh")
              .px(6)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .text_color(colors.foreground)
              .hover((el) => el.bg(colors.hover))
              .on_click((_event, clicked) => {
                this.request(clicked)
              })
              .child("Refresh"),
          ),
      )
      .when(this.note !== "", (el) => el.child(div().text_color(colors.muted).child(this.note)))
      .when(this.asOf !== "", (el) => el.child(div().text_color(colors.dim).child(snapshotNote(this.asOf))))
      .children(rows)
  }
}
