// src/sidebar/header.ts
import { h_flex } from "gpui-base";
import { div as div2, View } from "gpui-kit";
import { theme, window } from "herdr";

// src/shared/ui.ts
import { div, svg } from "gpui-kit";
var TRAFFIC_LIGHTS_INSET = 90;

// src/sidebar/header.ts
var header = (t) => {
  const w = window();
  const inset = w?.platform === "macos" && !w.fullscreen ? TRAFFIC_LIGHTS_INSET : 16;
  return h_flex().size_full().pl(inset).pr(12).items_center().gap(4).bg(t.chrome).text_size(14).child(div2().font_medium().text_color(t.foreground).child("Vibest"));
};

class SidebarHeader extends View {
  render() {
    return header(theme());
  }
}
export {
  SidebarHeader as default
};
