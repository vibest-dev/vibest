// mods/vibest-topbar/index.ts
import { View } from "gpui-kit";
import { layout, panes, spaces, window } from "herdr";

// shared/theme-colors.ts
import { theme } from "herdr";
var themeColors = () => theme();

// shared/traffic-lights.ts
var TRAFFIC_LIGHTS_INSET = 90;

// shared/thread-title.ts
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

// mods/vibest-topbar/topbar-state.ts
var RIGHT_PANEL = "right-panel";
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
var topbarState = (layout, spaces, panes) => {
  const root = layout;
  const panel = find(root, RIGHT_PANEL);
  const space = spaces.find((s) => s.active);
  const tab = space?.tabs.find((c) => c.active);
  return {
    breadcrumb: space ? {
      project: space.name,
      thread: tab ? threadTitle(tab, panes.filter((p) => p.tab === tab.id)) : "",
      branch: space.branch
    } : null,
    shownPanel: panel && !panel.hidden ? panel.active ?? null : null,
    sidebarHidden: Boolean(find(root, "sidebar")?.hidden)
  };
};

// mods/vibest-topbar/view.ts
import { h_flex } from "gpui-base";
import { div as div2, svg as svg2 } from "gpui-kit";
import { run } from "herdr";

// shared/icon-button.ts
import { div, svg } from "gpui-kit";
var icon = (name) => `mods/workspace-chrome/${name}.svg`;
var iconButton = (t, id, name, action, { size = 28, on = false } = {}) => div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(8).when(on, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => {
  cx.stop_propagation();
  action(cx);
}).child(svg(icon(name)).size(16));

// mods/vibest-topbar/view.ts
var panelButton = (t, shown, child, name) => {
  const on = shown === child;
  return iconButton(t, `panel-${child}`, name, () => {
    if (on)
      return run("layout.hide", { id: RIGHT_PANEL });
    run("layout.select", { stack: RIGHT_PANEL, child });
    run("layout.show", { id: RIGHT_PANEL });
  }, { on });
};
var branchChip = (t, branch) => h_flex().flex_none().h(20).px(6).gap(4).items_center().rounded(6).border(1).border_color(t.border).text_size(12).font_weight(400).text_color(t.muted).child(svg2(icon("git-branch")).size(12)).child(div2().max_w(160).truncate().child(branch));
var breadcrumbView = (t, crumb) => h_flex().flex_1().min_w(0).gap(8).items_center().child(svg2(icon("folder")).size(14).flex_none().text_color(t.muted)).child(div2().flex_none().max_w(160).truncate().text_color(t.muted).child(crumb.project)).child(div2().flex_none().text_color(t.dim).child("/")).child(div2().min_w(0).truncate().text_color(t.foreground).child(crumb.thread)).when(crumb.branch !== null && crumb.branch !== "", (el) => el.child(branchChip(t, crumb.branch)));
var topbarView = (t, state, win) => h_flex().size_full().min_w(0).pl(win.inset).pr(12).gap(12).items_center().bg(t.background).text_size(14).font_medium().child(state.breadcrumb ? breadcrumbView(t, state.breadcrumb) : div2().flex_1()).child(h_flex().flex_none().gap(4).items_center().child(panelButton(t, state.shownPanel, "files", "files")).child(panelButton(t, state.shownPanel, "changes", "git-compare")).child(panelButton(t, state.shownPanel, "agents", "monitor")).when(win.buttons, (el) => el.child(iconButton(t, "minimize", "minus", () => run("window.minimize"))).child(iconButton(t, "maximize", "square", () => run("window.maximize"))).child(iconButton(t, "close-window", "x", () => run("window.close")))));

// mods/vibest-topbar/index.ts
class Topbar extends View {
  render() {
    const state = topbarState(layout(), spaces(), panes());
    const w = window();
    const lights = w?.platform === "macos" && !w.fullscreen && state.sidebarHidden;
    return topbarView(themeColors(), state, { inset: lights ? TRAFFIC_LIGHTS_INSET : 12, buttons: Boolean(w?.buttons) });
  }
}
export {
  Topbar as default
};
