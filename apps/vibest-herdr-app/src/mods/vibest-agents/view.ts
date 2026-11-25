import { h_flex, v_flex } from "gpui-base"
import { div, type Element, svg } from "gpui-kit"

import { icon } from "../../shared/icon-button.ts"
import { liveMetrics } from "../../shared/live-metrics.ts"
import { type AgentRow, groupAgents, type ProjectGroup } from "../../shared/project-groups.ts"
import { showSession, statusMark } from "../../shared/session-ui.ts"
import { SMALL, TEXT } from "../../shared/text-size.ts"
import type { Theme } from "../../shared/theme-colors.ts"
import { LOCAL, type VibestState } from "../../shared/vibest-model.ts"

export const projectAgents = (group: ProjectGroup | undefined): AgentRow[] => (group ? groupAgents(group) : [])

export const shownGroup = (groups: readonly ProjectGroup[], selected: string | null): ProjectGroup | undefined =>
  groups.find((g) => g.key === selected) ?? groups[0]

const machineLabel = (machine: string): string => (machine === LOCAL ? "This machine" : machine)

const agentRow = (t: Theme, { session: s, depth }: AgentRow, now: number): Element =>
  v_flex()
    .id(`agent-${s.machine}-${s.id}`)
    .pl(8 + depth * 16)
    .pr(8)
    .py(8)
    .gap(4)
    .rounded(8)
    .flex_none()
    .hover((el) => el.bg(t.hover))
    .cursor_pointer()
    .on_click(() => showSession(s))
    .child(
      h_flex()
        .gap(4)
        .items_center()
        .child(
          div().flex_1().min_w(0).truncate().text_size(TEXT()).font_medium().text_color(t.foreground).child(s.name),
        )
        .child(statusMark(t, s.status, s.lastActive, now)),
    )
    .child(
      h_flex()
        .gap(4)
        .items_center()
        .text_size(SMALL())
        .text_color(t.dim)
        .child(
          svg(icon(s.machine === LOCAL ? "monitor" : "server"))
            .size(16)
            .flex_none(),
        )
        .child(div().flex_none().child(machineLabel(s.machine)))
        .child(div().flex_1().min_w(0).truncate().child(s.branch)),
    )

export const agentsView = (t: Theme, group: ProjectGroup | undefined, state: VibestState, now: number): Element => {
  const rows = projectAgents(group)
  const offline = state.machines.filter((m) => m.state !== "connected")

  return v_flex()
    .id("agents")
    .size_full()
    .min_h(0)
    .bg(t.background)
    .border(1)
    .border_color(t.border)
    .rounded(8)
    .overflow_hidden()
    .child(
      h_flex()
        .h(liveMetrics().head)
        .flex_none()
        .px(8)
        .py(4)
        .gap(4)
        .items_center()
        .border_b(1)
        .border_color(t.border)
        .text_size(TEXT())
        .child(div().font_semibold().text_color(t.foreground).child("Agents"))
        .child(div().text_color(t.dim).child(String(rows.length)))
        .when(group !== undefined, (el) =>
          el.child(
            div()
              .flex_none()
              .text_color(t.muted)
              .child(group?.label ?? ""),
          ),
        )
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(SMALL()).text_color(t.dim).child(state.note)),
    )
    .child(
      v_flex()
        .id("agents-list")
        .flex_1()
        .min_h(0)
        .gap(4)
        .overflow_y_scrollbar()
        .when(rows.length === 0, (el) =>
          el.child(
            div()
              .p(8)
              .text_size(TEXT())
              .text_color(t.muted)
              .child(group ? "No agents in this project." : "No vibest projects yet."),
          ),
        )
        .children(rows.map((row) => agentRow(t, row, now)))
        .children(
          offline.map((m) =>
            div()
              .id(`offline-${m.name}`)
              .px(8)
              .pt(8)
              .text_size(SMALL())
              .text_color(t.dim)
              .child(`${m.name}: ${m.reason || m.state}`),
          ),
        ),
    )
}
