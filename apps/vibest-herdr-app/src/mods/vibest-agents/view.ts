import { h_flex, v_flex } from "gpui-base"
import { type Context, div, type Element } from "gpui-kit"

import type { Theme } from "../../shared/theme-colors.ts"
import type { LsResult, SessionRow } from "./ls.ts"
import {
  groupSessions,
  projectHeading,
  rowTitle,
  rowTooltip,
  sessionStatus,
  shortId,
  snapshotNote,
} from "./sessions.ts"

const sessionRow = (t: Theme, session: SessionRow): Element =>
  h_flex()
    .id(`session-${session.id}`)
    .gap(8)
    .px(2)
    .py(2)
    .items_center()
    .rounded(4)
    .tooltip(rowTooltip(session))
    .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(rowTitle(session)))
    .child(div().flex_none().text_color(t.muted).child(sessionStatus(session)))
    .child(div().flex_none().text_color(t.dim).child(shortId(session)))

export const agentsView = (t: Theme, shown: LsResult, refresh: (cx: Context) => void): Element => {
  const rows = groupSessions(shown.sessions).flatMap((group) => [
    div()
      .id(`project-${group.projectId}`)
      .truncate()
      .text_color(t.dim)
      .child(projectHeading(group.projectId, group.label)),
    ...group.sessions.map((session) => sessionRow(t, session)),
  ])
  return v_flex()
    .id("agents")
    .size_full()
    .bg(t.background)
    .rounded(10)
    .p(10)
    .gap(6)
    .text_size(12)
    .overflow_y_scrollbar()
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(div().font_semibold().text_color(t.foreground).child("Agents"))
        .child(div().flex_1())
        .child(
          div()
            .id("agents-refresh")
            .px(6)
            .py(2)
            .rounded(4)
            .cursor_pointer()
            .text_color(t.foreground)
            .hover((el) => el.bg(t.hover))
            .on_click((_event, clicked) => refresh(clicked))
            .child("Refresh"),
        ),
    )
    .when(shown.note !== "", (el) => el.child(div().text_color(t.muted).child(shown.note)))
    .when(shown.asOf !== "", (el) => el.child(div().text_color(t.dim).child(snapshotNote(shown.asOf))))
    .children(rows)
}
