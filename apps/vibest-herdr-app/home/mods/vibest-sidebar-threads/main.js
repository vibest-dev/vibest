// src/sidebar/threads/vibest-sidebar-threads.ts
import { View } from "gpui-kit";

// src/shared/theme.ts
import { theme } from "herdr";
var themeColors = () => theme();

// src/sidebar/threads/view.ts
import { h_flex, v_flex } from "gpui-base";
import { div as div2, svg as svg2 } from "gpui-kit";
import { openOverlay, panes, pickFolder, run, spaces } from "herdr";

// src/shared/ui.ts
import { div, svg } from "gpui-kit";
var TRAFFIC_LIGHTS_INSET = 90;
var icon = (name) => `mods/workspace-chrome/${name}.svg`;
var iconButton = (t, id, name, action, { size = 28, on = false } = {}) => div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(8).when(on, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => {
  cx.stop_propagation();
  action(cx);
}).child(svg(icon(name)).size(16));

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

// src/sidebar/threads/model.ts
var parseFolded = (stored) => {
  try {
    const value = JSON.parse(stored ?? "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
};
var projects = (spaces, panes) => {
  const byTab = new Map;
  for (const p of panes) {
    const list = byTab.get(p.tab);
    if (list)
      list.push(p);
    else
      byTab.set(p.tab, [p]);
  }
  return spaces.map((s) => ({
    id: s.id,
    name: s.name,
    machine: s.machine,
    active: s.active,
    status: s.status,
    threads: s.tabs.filter((t) => !t.settled || t.active).map((t) => ({
      id: t.id,
      title: threadTitle(t, byTab.get(t.id) ?? []),
      active: s.active && t.active,
      status: t.status,
      changedAt: t.changed_at,
      workingSince: t.working_since
    }))
  }));
};
var relativeTime = (at, now) => {
  if (at === null)
    return "";
  const seconds = Math.floor(Math.max(0, now - at) / 1000);
  if (seconds < 60)
    return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};
var elapsed = (since, now) => {
  if (since === null)
    return "";
  const minutes = Math.floor(Math.max(0, now - since) / 60000);
  if (minutes < 1)
    return "";
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
};
var PILLS = {
  working: { label: "Working", tone: "working", pulse: true },
  blocked: { label: "Awaiting Input", tone: "blocked", pulse: false },
  done: { label: "Done", tone: "done", pulse: false }
};
var pill = (status) => status === null ? null : PILLS[status] ?? null;

// src/sidebar/threads/view.ts
var CLOCK_MS = 30000;

class ThreadList {
  hovered = null;
  folded = new Set(parseFolded(localStorage.getItem("folded")));
  now = Date.now();
  constructor(cx) {
    cx.timer.every(CLOCK_MS, (ticked) => {
      this.now = Date.now();
      ticked.notify();
    });
  }
  hover(id) {
    return (on, cx) => {
      if (on)
        this.hovered = id;
      else if (this.hovered === id)
        this.hovered = null;
      cx.notify();
    };
  }
  fold(id) {
    if (this.folded.has(id))
      this.folded.delete(id);
    else
      this.folded.add(id);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
  }
  toolbar(t) {
    const active = spaces().find((s) => s.active);
    return h_flex().px(8).pb(8).gap(4).items_center().flex_none().child(h_flex().id("search").flex_1().h(32).px(8).gap(8).items_center().rounded(6).text_size(14).font_medium().text_color(t.muted).hover((s) => s.bg(t.hover)).cursor_pointer().on_click(() => run("mod.open", { name: "picker" })).child(svg2(icon("search")).size(16)).child("Search")).when(spaces().length > 0, (el) => el.child(iconButton(t, "add-project", "folder-plus", (cx) => this.addProject(cx)))).child(iconButton(t, "new-thread", "square-pen", () => run("tab.new", active ? { space: active.id } : {})));
  }
  addProject(cx) {
    cx.spawn(async () => {
      const folder = await pickFolder({ prompt: "Add project" });
      if (folder)
        run("space.new", { folder });
    });
  }
  status(t, thread) {
    const p = pill(thread.status);
    if (!p)
      return div2().text_size(12).text_color(t.dim).child(relativeTime(thread.changedAt, this.now));
    const color = t[p.tone];
    const dot = div2().size(6).flex_none().rounded_full().bg(color);
    const since = thread.status === "working" ? elapsed(thread.workingSince, this.now) : "";
    return h_flex().gap(6).items_center().text_size(12).font_medium().text_color(color).child(p.pulse ? dot.loop("opacity", { from: 0.5, to: 1, period: 2000 }) : dot).child(since ? `${p.label} ${since}` : p.label);
  }
  threadRow(t, project, thread) {
    const id = `thread-${thread.id}`;
    return h_flex().id(id).h(36).pl(36).pr(10).gap(10).items_center().rounded(6).flex_none().border(1).border_color(thread.active ? t.border : t.chrome).bg(thread.active ? t.selected : t.chrome).hover((s) => s.bg(thread.active ? t.selected : t.hover)).cursor_pointer().on_hover(this.hover(id)).on_click(() => {
      run("space.select", { id: project.id });
      run("tab.select", { id: thread.id });
    }).on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation();
      openOverlay({
        mod: "menu",
        kind: "popup",
        width: 200,
        props: { tab: "tab", target: { id: thread.id, space: project.id } }
      });
    }).child(div2().flex_1().min_w(0).truncate().text_size(14).font_medium().text_color(t.foreground).child(thread.title)).child(h_flex().h(24).min_w(32).flex_none().justify_end().items_center().child(this.status(t, thread)));
  }
  projectRow(t, project) {
    const id = `project-${project.id}`;
    const folded = this.folded.has(project.id);
    const hovered = this.hovered === id;
    const tone = project.status && project.status !== "idle" ? t[project.status] : null;
    return h_flex().id(id).h(32).mt(8).px(10).gap(10).items_center().rounded(8).flex_none().hover((s) => s.bg(t.hover)).cursor_pointer().on_hover(this.hover(id)).on_click((_e, cx) => {
      this.fold(project.id);
      cx.notify();
    }).on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation();
      openOverlay({
        mod: "menu",
        kind: "popup",
        width: 200,
        height: 260,
        props: { tab: "space", target: { id: project.id } }
      });
    }).child(svg2(icon("folder")).size(16).flex_none().text_color(t.muted)).child(div2().flex_1().min_w(0).truncate().text_size(14).font_medium().text_color(project.active ? t.foreground : t.muted).child(project.name)).when(Boolean(project.machine), (el) => el.child(div2().flex_none().text_size(12).text_color(t.dim).child(project.machine))).when(folded && tone !== null && !hovered, (el) => el.child(div2().size(6).flex_none().rounded_full().bg(tone))).when(folded && !hovered, (el) => el.child(div2().flex_none().text_size(12).text_color(t.dim).child(String(project.threads.length)))).when(hovered, (el) => el.child(iconButton(t, `new-${project.id}`, "square-pen", () => run("tab.new", { space: project.id }), { size: 24 }))).child(svg2(icon(folded ? "chevron-right" : "chevron-down")).size(12).flex_none().text_color(t.muted));
  }
  list(t) {
    const all = projects(spaces(), panes());
    if (!all.length)
      return v_flex().flex_1().px(18).pt(16).gap(4).text_size(12).text_color(t.muted).child("No projects yet.").child(div2().id("empty-add").text_color(t.foreground).cursor_pointer().on_click(() => run("space.new")).child("New project"));
    return v_flex().id("projects").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar().children(all.flatMap((project) => [
      this.projectRow(t, project),
      ...this.folded.has(project.id) ? [] : project.threads.map((thread) => this.threadRow(t, project, thread))
    ]));
  }
  render(t) {
    return v_flex().size_full().bg(t.chrome).child(this.toolbar(t)).child(this.list(t));
  }
}

// src/sidebar/threads/vibest-sidebar-threads.ts
class SidebarThreads extends View {
  list;
  init(_props, cx) {
    this.list = new ThreadList(cx);
  }
  render() {
    return this.list.render(themeColors());
  }
}
export {
  SidebarThreads as default
};
