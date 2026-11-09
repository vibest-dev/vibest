// src/workspace/vibest-topbar.ts
import { h_flex } from "gpui-base";
import { div as div2, svg as svg2, View } from "gpui-kit";
import { focused, layout, panes, run, spaces, window } from "herdr";

// src/shared/thread-title.ts
var leading = (s) => s.replace(/^[^\p{L}\p{N}]+/u, "").trim();
var looksLikePath = (s) => /^[~/]|^[A-Za-z]:\\/.test(s) || s.includes("@");
var threadTitle = (tab, tabPanes) => {
  if (tab.named)
    return tab.name;
  const lead = tabPanes.find((p) => p.program?.agent) ?? tabPanes.find((p) => p.terminal) ?? tabPanes[0];
  const raw = (lead?.title ?? "").trim();
  const live = leading(raw);
  if (live && live !== lead?.terminal && !looksLikePath(raw) && live.toLowerCase() !== lead?.program?.key)
    return live;
  return lead?.program?.agent ? lead.program.name : `Terminal ${tab.index}`;
};

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

// src/workspace/vibest-topbar.ts
var find = (node, id) => {
  if (node?.id === id)
    return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found)
      return found;
  }
  return;
};
var RIGHT_PANEL = "right-panel";
var panelButton = (t, root, child, name) => {
  const panel = find(root, RIGHT_PANEL);
  const on = Boolean(panel && !panel.hidden && panel.active === child);
  return iconButton(t, `panel-${child}`, name, () => {
    if (on)
      return run("layout.hide", { id: RIGHT_PANEL });
    run("layout.select", { stack: RIGHT_PANEL, child });
    run("layout.show", { id: RIGHT_PANEL });
  }, { on });
};
var topbar = (t) => {
  const w = window();
  const root = layout();
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs.find((c) => c.active);
  const tabPanes = tab ? panes().filter((p) => p.tab === tab.id) : [];
  const pane = focused()?.pane;
  const zoomed = Boolean(tab?.zoomed);
  const inset = w?.platform === "macos" && !w.fullscreen && find(root, "sidebar")?.hidden ? TRAFFIC_LIGHTS_INSET : 12;
  return h_flex().size_full().min_w(0).pl(inset).pr(12).gap(12).items_center().bg(t.background).text_size(14).font_medium().child(h_flex().flex_1().min_w(0).gap(8).items_center().when(space !== undefined, (el) => el.child(svg2(icon("folder")).size(14).flex_none().text_color(t.muted)).child(div2().flex_none().max_w(160).truncate().text_color(t.muted).child(space?.name)).child(div2().flex_none().text_color(t.dim).child("/")).child(div2().min_w(0).truncate().text_color(t.foreground).child(tab ? threadTitle(tab, tabPanes) : "")).when(Boolean(space?.branch), (el) => el.child(h_flex().flex_none().h(20).px(6).gap(4).items_center().rounded(6).border(1).border_color(t.border).text_size(12).font_weight(400).text_color(t.muted).child(svg2(icon("git-branch")).size(12)).child(div2().max_w(160).truncate().child(space?.branch)))))).child(h_flex().flex_none().gap(4).items_center().child(iconButton(t, "split", "terminal", () => run("pane.split", { direction: "right", ...pane ? { pane } : {} }))).child(panelButton(t, root, "files", "files")).child(panelButton(t, root, "changes", "git-compare")).child(panelButton(t, root, "agents", "monitor")).child(iconButton(t, "zoom", zoomed ? "minus" : "square", () => run("pane.zoom", pane ? { pane } : {}), {
    on: zoomed
  })).when(Boolean(w?.buttons), (el) => el.child(iconButton(t, "minimize", "minus", () => run("window.minimize"))).child(iconButton(t, "maximize", "square", () => run("window.maximize"))).child(iconButton(t, "close-window", "x", () => run("window.close")))));
};

class Topbar extends View {
  render() {
    return topbar(themeColors());
  }
}
export {
  Topbar as default
};
