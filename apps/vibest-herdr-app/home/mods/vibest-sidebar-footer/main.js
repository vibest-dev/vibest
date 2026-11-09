// src/sidebar/footer.ts
import { h_flex } from "gpui-base";
import { div as div2, View } from "gpui-kit";
import { run, theme, updates } from "herdr";

// src/shared/ui.ts
import { div, svg } from "gpui-kit";
var icon = (name) => `mods/workspace-chrome/${name}.svg`;
var iconButton = (t, id, name, action, { size = 28, on = false } = {}) => div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(8).when(on, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => {
  cx.stop_propagation();
  action(cx);
}).child(svg(icon(name)).size(16));

// src/sidebar/footer.ts
var footer = (t) => {
  const ready = Boolean(updates()?.app?.ready);
  return h_flex().size_full().px(8).pt(4).pb(8).gap(4).items_center().bg(t.chrome).child(h_flex().relative().child(iconButton(t, "settings", "settings", () => run("app.settings"), { size: 32 })).when(ready, (el) => el.child(div2().absolute().top(6).right(6).size(6).rounded_full().bg(t.accent)))).child(iconButton(t, "add-machine", "server", () => run("mod.open", { name: "machine-add" }), { size: 32 })).child(div2().flex_1()).child(iconButton(t, "palette", "layers", () => run("app.palette"), { size: 32 }));
};

class SidebarFooter extends View {
  render() {
    return footer(theme());
  }
}
export {
  SidebarFooter as default
};
