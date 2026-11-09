import { h_flex } from "gpui-base"
import { div, View } from "gpui-kit"
import { run, type Theme, theme, updates } from "herdr"

import { iconButton } from "../shared/ui.ts"

const footer = (t: Theme): Chain => {
  const ready = Boolean(updates()?.app?.ready)
  return h_flex()
    .size_full()
    .px(8)
    .pt(4)
    .pb(8)
    .gap(4)
    .items_center()
    .bg(t.chrome)
    .child(
      h_flex()
        .relative()
        .child(iconButton(t, "settings", "settings", () => run("app.settings"), { size: 32 }))
        .when(ready, (el) => el.child(div().absolute().top(6).right(6).size(6).rounded_full().bg(t.accent))),
    )
    .child(iconButton(t, "add-machine", "server", () => run("mod.open", { name: "machine-add" }), { size: 32 }))
    .child(div().flex_1())
    .child(iconButton(t, "palette", "layers", () => run("app.palette"), { size: 32 }))
}

export default class SidebarFooter extends View {
  render(): unknown {
    return footer(theme())
  }
}
