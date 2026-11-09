// src/sidebar/vibest-sidebar-header.ts
import { h_flex } from "gpui-base";
import { div as div2, View } from "gpui-kit";
import { window } from "herdr";

// src/shared/theme.ts
import { theme } from "herdr";
var themeColors = () => theme();

// src/shared/ui.ts
import { div, svg } from "gpui-kit";
var TRAFFIC_LIGHTS_INSET = 90;
var icon = (name) => `mods/workspace-chrome/${name}.svg`;
var iconButton = (t, id, name, action, { size = 28, on = false } = {}) => div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(8).when(on, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => {
  cx.stop_propagation();
  action(cx);
}).child(svg(icon(name)).size(16));

// src/sidebar/vibest-sidebar-header.ts
var header = (t) => {
  const w = window();
  const inset = w?.platform === "macos" && !w.fullscreen ? TRAFFIC_LIGHTS_INSET : 16;
  return h_flex().size_full().pl(inset).pr(12).items_center().gap(4).bg(t.chrome).text_size(14).child(div2().font_medium().text_color(t.foreground).child("Vibest"));
};

class SidebarHeader extends View {
  render() {
    return header(themeColors());
  }
}
export {
  SidebarHeader as default
};
