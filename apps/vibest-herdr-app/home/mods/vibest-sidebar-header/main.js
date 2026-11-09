// src/sidebar/header/vibest-sidebar-header.ts
import { h_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { window } from "herdr";

// src/shared/theme-colors.ts
import { theme } from "herdr";
var themeColors = () => theme();

// src/shared/traffic-lights.ts
var TRAFFIC_LIGHTS_INSET = 90;

// src/sidebar/header/vibest-sidebar-header.ts
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
