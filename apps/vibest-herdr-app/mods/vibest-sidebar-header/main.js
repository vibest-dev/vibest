// mods/vibest-sidebar-header/index.ts
import { h_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { window } from "herdr";

// shared/theme-colors.ts
import { theme } from "herdr";
var themeColors = () => theme();

// shared/traffic-lights.ts
var TRAFFIC_LIGHTS_INSET = 90;

// mods/vibest-sidebar-header/index.ts
var header = (t) => {
  const w = window();
  const inset = w?.platform === "macos" && !w.fullscreen ? TRAFFIC_LIGHTS_INSET : 16;
  return h_flex().size_full().pl(inset).pr(12).items_center().gap(4).bg(t.chrome).text_size(14).child(div().font_medium().text_color(t.foreground).child("Vibest"));
};

class SidebarHeader extends View {
  render() {
    return header(themeColors());
  }
}
export {
  SidebarHeader as default
};
