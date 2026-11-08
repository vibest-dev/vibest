import { h_flex, v_flex } from "gpui-base"
import { div, View } from "gpui-kit"
import { appHome, exec, panes, terminals, theme } from "herdr"

import {
  cliArgv,
  closePull,
  commandNote,
  completePull,
  coreTerminals,
  groupSessions,
  idlePull,
  modelPanes,
  parseSessions,
  placeSession,
  projectHeading,
  type Pull,
  requestPull,
  rowTitle,
  type SessionRow,
  settleList,
  snapshotNote,
  statusText,
  statusVerdict,
} from "./sessions.ts"

const windowCoreSocket = undefined

export default class VibestSessions extends View {
  sessions!: readonly SessionRow[]
  note!: string
  asOf!: string
  pull!: Pull

  init(_props: unknown, cx: Cx): void {
    this.sessions = []
    this.note = "Reading vibestd…"
    this.asOf = ""
    this.pull = idlePull()
    this.request(cx)
  }

  close(_cx: Cx): void {
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
      const cwd = appHome()
      const status = await exec("env", cliArgv("status"), { cwd })
      if (status.code !== 0) note = commandNote(status, "vibest status failed")
      else {
        const verdict = statusVerdict(status.stdout)
        if (verdict === undefined) note = "vibest status was not understood"
        else if (!verdict.list) note = verdict.message
        else {
          const listed = settleList(await exec("env", cliArgv("ls"), { cwd }))
          if (!listed.ok) note = listed.note
          else {
            const parsed = parseSessions(listed.stdout)
            if (parsed === undefined) note = "vibest ls was not understood"
            else {
              sessions = parsed
              asOf = new Date().toISOString().slice(11, 19)
              note = parsed.length === 0 ? "No live sessions." : ""
            }
          }
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

  sessionRow(colors: Record<string, string>, session: SessionRow): Chain {
    const place = placeSession(session, coreTerminals(terminals()), modelPanes(panes()), windowCoreSocket)
    const row = h_flex()
      .id(`session-${session.id}`)
      .gap(6)
      .px(2)
      .py(2)
      .items_center()
      .rounded(4)
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
    return row.child(
      div()
        .flex_none()
        .text_color(colors.dim ?? "")
        .child(place.action === "none" ? place.reason : "core not proven"),
    )
  }

  render(_cx: Cx): Chain {
    const colors = theme()
    const rows = groupSessions(this.sessions).flatMap((group) => [
      div()
        .id(`project-${group.projectId}`)
        .truncate()
        .text_color(colors.dim ?? "")
        .child(projectHeading(group.projectId, group.label)),
      ...group.sessions.map((session) => this.sessionRow(colors, session)),
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
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .font_semibold()
              .text_color(colors.foreground ?? "")
              .child("Vibest"),
          )
          .child(div().flex_1())
          .child(
            div()
              .id("vibest-refresh")
              .px(6)
              .py(2)
              .rounded(4)
              .cursor_pointer()
              .text_color(colors.foreground ?? "")
              .hover((el) => el.bg(colors.hover ?? ""))
              .on_click((_event, clicked) => {
                this.request(clicked)
              })
              .child("Refresh"),
          ),
      )
      .when(this.note !== "", (el) =>
        el.child(
          div()
            .text_color(colors.muted ?? "")
            .child(this.note),
        ),
      )
      .when(this.asOf !== "", (el) =>
        el.child(
          div()
            .text_color(colors.dim ?? "")
            .child(snapshotNote(this.asOf)),
        ),
      )
      .children(rows)
  }
}
