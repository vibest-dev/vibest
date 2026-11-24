import { h_flex } from "gpui-base"
import { div, type Element, View } from "gpui-kit"
import { run, updates } from "herdr"

import { BUTTON, ICON, iconButton } from "../../shared/icon-button.ts"
import { themeColors } from "../../shared/theme-colors.ts"

export default class SidebarFooter extends View {
  render(): Element {
    const t = themeColors()

    return h_flex()
      .size_full()
      .bg(t.chrome)
      .px(4 + (BUTTON - ICON) / 2)
      .items_center()
      .child(
        div()
          .relative()
          .child(iconButton(t, "settings", "settings", () => run("app.settings")))
          .when(Boolean(updates().app.ready), (el) =>
            el.child(div().absolute().top(2).right(2).size(8).rounded_full().bg(t.accent)),
          ),
      )
  }
}
