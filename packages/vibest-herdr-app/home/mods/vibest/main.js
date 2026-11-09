// src/main.ts
import { View } from "gpui-kit";
import { props, theme } from "herdr";

// src/agents/view.ts
import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { appHome, exec } from "herdr";

// src/agents/cli.ts
var STRIPPED = ["VIBEST_SESSION_ID", "VIBEST_AGENT", "VIBEST_PROJECT_ID"];
var cliArgv = (command) => [
  ...STRIPPED.flatMap((name) => ["-u", name]),
  ...command === "status" ? ["VIBEST_NO_UPDATE_CHECK=1"] : [],
  "vibest",
  command,
  ...command === "ls" ? ["--no-start", "--all-projects"] : []
];
var commandNote = (result, fallback) => {
  if (result.code === 0)
    return "";
  const trimmed = (result.stderr || result.stdout).trim();
  return (trimmed === "" ? fallback : trimmed).slice(0, 180);
};
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var text = (value) => typeof value === "string" ? value : undefined;
var parseOwnedAddress = (id) => {
  const at = id.indexOf("@");
  if (at <= 0 || at === id.length - 1)
    return;
  return { address: id.slice(0, at), socket: id.slice(at + 1) };
};
var statusVerdict = (stdout) => {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    return;
  }
  if (!isRecord(value) || !isRecord(value.daemon))
    return;
  const status = text(value.daemon.status);
  if (status === undefined)
    return;
  if (status !== "running")
    return { list: false, message: "vibestd is not running" };
  const client = isRecord(value.client) ? value.client : undefined;
  const clientVersion = client ? text(client.version) : undefined;
  const daemonVersion = text(value.daemon.version);
  if (value.daemon.sameVersion !== true)
    return {
      list: false,
      message: `vibestd ${daemonVersion ?? "unknown"} is not this vibest ${clientVersion ?? "unknown"}`
    };
  if (typeof value.daemon.protocol !== "number")
    return { list: false, message: "vibest status has no protocol" };
  return { list: true };
};
var sessionRow = (item) => {
  const id = text(item.id);
  const projectId = text(item.projectId);
  const address = isRecord(item.address) ? item.address : undefined;
  const addressId = address ? text(address.id) : undefined;
  const machine = address ? text(address.machine) : undefined;
  if (id === undefined || projectId === undefined || addressId === undefined || machine === undefined)
    return;
  const owned = parseOwnedAddress(addressId);
  return {
    id,
    projectId,
    title: text(item.title) ?? text(item.name) ?? "",
    agent: text(item.agent) ?? "",
    harness: text(item.harness) ?? "",
    status: text(item.status) ?? "unknown",
    turnState: text(item.turnState) ?? "",
    runtime: text(item.runtime) ?? "",
    machine,
    addressId,
    socket: owned?.socket ?? "",
    coreAddress: owned?.address ?? "",
    repositoryRoot: item.repositoryRoot === null ? null : text(item.repositoryRoot) ?? null
  };
};
var parseSessions = (stdout) => {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    return;
  }
  if (!Array.isArray(value))
    return;
  const rows = [];
  for (const item of value) {
    if (!isRecord(item))
      return;
    const row = sessionRow(item);
    if (row === undefined)
      return;
    rows.push(row);
  }
  return rows;
};

// src/agents/model.ts
var idlePull = () => ({ token: 0, closed: false, running: false, again: false });
var rowNote = (session) => {
  if (session.runtime !== "hc")
    return `runtime ${session.runtime || "unknown"}`;
  if (session.machine !== "local")
    return "on another machine";
  if (session.socket === "" || session.coreAddress.includes("/"))
    return "no local terminal";
  return "";
};
var shortId = (row) => row.id.slice(0, 8);
var rowTooltip = (row) => [row.id, row.harness, rowNote(row)].filter((part) => part !== "").join(" · ");
var rowTitle = (row) => row.title || row.agent || shortId(row);
var snapshotNote = (asOf) => `Snapshot ${asOf} UTC, not a watch.`;
var folderName = (root) => root.split("/").filter((part) => part !== "").at(-1);
var projectHeading = (projectId, label) => {
  const short = projectId.slice(0, 8);
  return label === short ? short : `${label} · ${short}`;
};
var groupSessions = (rows) => {
  const order = [];
  const grouped = new Map;
  for (const row of rows) {
    const list = grouped.get(row.projectId);
    if (list === undefined) {
      order.push(row.projectId);
      grouped.set(row.projectId, [row]);
    } else
      list.push(row);
  }
  return order.flatMap((projectId) => {
    const sessions = grouped.get(projectId);
    const first = sessions?.[0];
    if (sessions === undefined || first === undefined)
      return [];
    const label = first.repositoryRoot !== null && folderName(first.repositoryRoot) || projectId.slice(0, 8);
    return [{ projectId, label, sessions }];
  });
};
var requestPull = (pull) => {
  if (pull.closed)
    return pull;
  if (pull.running)
    return { ...pull, again: true };
  return { token: pull.token + 1, closed: false, running: true, again: false };
};
var completePull = (pull, token) => {
  if (pull.closed || token !== pull.token)
    return { pull, apply: false };
  if (pull.again)
    return { apply: false, pull: { token: pull.token + 1, closed: false, running: true, again: false } };
  return { apply: true, pull: { ...pull, running: false } };
};
var closePull = (pull) => ({
  token: pull.token + 1,
  closed: true,
  running: false,
  again: false
});
var sessionStatus = (row) => row.turnState === "" || row.turnState === "none" ? row.status : `${row.status}/${row.turnState}`;

// src/agents/view.ts
class AgentList {
  sessions = [];
  note = "Reading vibestd…";
  asOf = "";
  pull = idlePull();
  constructor(cx) {
    this.request(cx);
  }
  close() {
    this.pull = closePull(this.pull);
  }
  request(cx) {
    const next = requestPull(this.pull);
    const started = !this.pull.running && next.running;
    this.pull = next;
    if (!started)
      return;
    const token = next.token;
    cx.spawn(async (spawned) => {
      await this.read(spawned, token);
    });
  }
  async read(cx, token) {
    let note = "";
    let asOf = "";
    let sessions = [];
    try {
      const cwd = appHome();
      const status = await exec("env", cliArgv("status"), { cwd });
      if (status.code !== 0)
        note = commandNote(status, "vibest status failed");
      else {
        const verdict = statusVerdict(status.stdout);
        if (verdict === undefined)
          note = "vibest status was not understood";
        else if (!verdict.list)
          note = verdict.message;
        else {
          const listed = await exec("env", cliArgv("ls"), { cwd });
          if (listed.code !== 0)
            note = commandNote(listed, "vibest ls failed");
          else {
            const parsed = parseSessions(listed.stdout);
            if (parsed === undefined)
              note = "vibest ls was not understood";
            else {
              sessions = parsed;
              asOf = new Date().toISOString().slice(11, 19);
              note = parsed.length === 0 ? "No live sessions." : "";
            }
          }
        }
      }
    } catch (error) {
      note = commandNote({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : "vibest could not be run" }, "vibest could not be run");
    }
    const done = completePull(this.pull, token);
    this.pull = done.pull;
    if (done.apply) {
      this.sessions = sessions;
      this.note = note;
      this.asOf = asOf;
      cx.notify();
    }
    if (this.pull.running) {
      const follow = this.pull.token;
      cx.spawn(async (spawned) => {
        await this.read(spawned, follow);
      });
    }
  }
  sessionRow(colors, session) {
    return h_flex().id(`session-${session.id}`).gap(8).px(2).py(2).items_center().rounded(4).tooltip(rowTooltip(session)).child(div().flex_1().min_w(0).truncate().text_color(colors.foreground).child(rowTitle(session))).child(div().flex_none().text_color(colors.muted).child(sessionStatus(session))).child(div().flex_none().text_color(colors.dim).child(shortId(session)));
  }
  render(colors) {
    const rows = groupSessions(this.sessions).flatMap((group) => [
      div().id(`project-${group.projectId}`).truncate().text_color(colors.dim).child(projectHeading(group.projectId, group.label)),
      ...group.sessions.map((session) => this.sessionRow(colors, session))
    ]);
    return v_flex().id("agents").size_full().bg(colors.surface).p(10).gap(6).text_size(12).overflow_y_scrollbar().child(h_flex().gap(8).items_center().child(div().font_semibold().text_color(colors.foreground).child("Agents")).child(div().flex_1()).child(div().id("agents-refresh").px(6).py(2).rounded(4).cursor_pointer().text_color(colors.foreground).hover((el) => el.bg(colors.hover)).on_click((_event, clicked) => {
      this.request(clicked);
    }).child("Refresh"))).when(this.note !== "", (el) => el.child(div().text_color(colors.muted).child(this.note))).when(this.asOf !== "", (el) => el.child(div().text_color(colors.dim).child(snapshotNote(this.asOf)))).children(rows);
  }
}

// src/footer.ts
import { h_flex as h_flex2 } from "gpui-base";
import { div as div3 } from "gpui-kit";
import { run, updates } from "herdr";

// src/ui.ts
import { div as div2, svg } from "gpui-kit";
var TRAFFIC_LIGHTS_INSET = 90;
var icon = (name) => `mods/workspace-chrome/${name}.svg`;
var iconButton = (t, id, name, action, { size = 28, on = false } = {}) => div2().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(8).when(on, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => {
  cx.stop_propagation();
  action(cx);
}).child(svg(icon(name)).size(16));

// src/footer.ts
var footer = (t) => {
  const ready = Boolean(updates()?.app?.ready);
  return h_flex2().size_full().px(8).pt(4).pb(8).gap(4).items_center().bg(t.chrome).child(h_flex2().relative().child(iconButton(t, "settings", "settings", () => run("app.settings"), { size: 32 })).when(ready, (el) => el.child(div3().absolute().top(6).right(6).size(6).rounded_full().bg(t.accent)))).child(iconButton(t, "add-machine", "server", () => run("mod.open", { name: "machine-add" }), { size: 32 })).child(div3().flex_1()).child(iconButton(t, "palette", "layers", () => run("app.palette"), { size: 32 }));
};

// src/header.ts
import { h_flex as h_flex3 } from "gpui-base";
import { div as div4 } from "gpui-kit";
import { window } from "herdr";
var header = (t) => {
  const w = window();
  const inset = w?.platform === "macos" && !w.fullscreen ? TRAFFIC_LIGHTS_INSET : 16;
  return h_flex3().size_full().pl(inset).pr(12).items_center().gap(4).bg(t.chrome).text_size(14).child(div4().font_medium().text_color(t.foreground).child("Vibest"));
};

// src/threads/view.ts
import { h_flex as h_flex4, v_flex as v_flex2 } from "gpui-base";
import { div as div5, svg as svg2 } from "gpui-kit";
import { openOverlay, panes, pickFolder, run as run2, spaces } from "herdr";

// src/threads/model.ts
var leading = (s) => s.replace(/^[^\p{L}\p{N}]+/u, "").trim();
var looksLikePath = (s) => /^[~/]|^[A-Za-z]:\\/.test(s) || s.includes("@");
var parseFolded = (stored) => {
  try {
    const value = JSON.parse(stored ?? "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
};
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

// src/threads/view.ts
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
    return h_flex4().px(8).pb(8).gap(4).items_center().flex_none().child(h_flex4().id("search").flex_1().h(32).px(8).gap(8).items_center().rounded(6).text_size(14).font_medium().text_color(t.muted).hover((s) => s.bg(t.hover)).cursor_pointer().on_click(() => run2("mod.open", { name: "picker" })).child(svg2(icon("search")).size(16)).child("Search")).when(spaces().length > 0, (el) => el.child(iconButton(t, "add-project", "folder-plus", (cx) => this.addProject(cx)))).child(iconButton(t, "new-thread", "square-pen", () => run2("tab.new", active ? { space: active.id } : {})));
  }
  addProject(cx) {
    cx.spawn(async () => {
      const folder = await pickFolder({ prompt: "Add project" });
      if (folder)
        run2("space.new", { folder });
    });
  }
  status(t, thread) {
    const p = pill(thread.status);
    if (!p)
      return div5().text_size(12).text_color(t.dim).child(relativeTime(thread.changedAt, this.now));
    const color = t[p.tone];
    const dot = div5().size(6).flex_none().rounded_full().bg(color);
    const since = thread.status === "working" ? elapsed(thread.workingSince, this.now) : "";
    return h_flex4().gap(6).items_center().text_size(12).font_medium().text_color(color).child(p.pulse ? dot.loop("opacity", { from: 0.5, to: 1, period: 2000 }) : dot).child(since ? `${p.label} ${since}` : p.label);
  }
  threadRow(t, project, thread) {
    const id = `thread-${thread.id}`;
    return h_flex4().id(id).h(36).pl(36).pr(10).gap(10).items_center().rounded(6).flex_none().border(1).border_color(thread.active ? t.border : t.chrome).bg(thread.active ? t.selected : t.chrome).hover((s) => s.bg(thread.active ? t.selected : t.hover)).cursor_pointer().on_hover(this.hover(id)).on_click(() => {
      run2("space.select", { id: project.id });
      run2("tab.select", { id: thread.id });
    }).on_mouse_down("right", (_e, cx) => {
      cx.stop_propagation();
      openOverlay({
        mod: "menu",
        kind: "popup",
        width: 200,
        props: { tab: "tab", target: { id: thread.id, space: project.id } }
      });
    }).child(div5().flex_1().min_w(0).truncate().text_size(14).font_medium().text_color(t.foreground).child(thread.title)).child(h_flex4().h(24).min_w(32).flex_none().justify_end().items_center().child(this.status(t, thread)));
  }
  projectRow(t, project) {
    const id = `project-${project.id}`;
    const folded = this.folded.has(project.id);
    const hovered = this.hovered === id;
    const tone = project.status && project.status !== "idle" ? t[project.status] : null;
    return h_flex4().id(id).h(32).mt(8).px(10).gap(10).items_center().rounded(8).flex_none().hover((s) => s.bg(t.hover)).cursor_pointer().on_hover(this.hover(id)).on_click((_e, cx) => {
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
    }).child(svg2(icon("folder")).size(16).flex_none().text_color(t.muted)).child(div5().flex_1().min_w(0).truncate().text_size(14).font_medium().text_color(project.active ? t.foreground : t.muted).child(project.name)).when(Boolean(project.machine), (el) => el.child(div5().flex_none().text_size(12).text_color(t.dim).child(project.machine))).when(folded && tone !== null && !hovered, (el) => el.child(div5().size(6).flex_none().rounded_full().bg(tone ?? ""))).when(folded && !hovered, (el) => el.child(div5().flex_none().text_size(12).text_color(t.dim).child(String(project.threads.length)))).when(hovered, (el) => el.child(iconButton(t, `new-${project.id}`, "square-pen", () => run2("tab.new", { space: project.id }), { size: 24 }))).child(svg2(icon(folded ? "chevron-right" : "chevron-down")).size(12).flex_none().text_color(t.muted));
  }
  list(t) {
    const all = projects(spaces(), panes());
    if (!all.length)
      return v_flex2().flex_1().px(18).pt(16).gap(4).text_size(12).text_color(t.muted).child("No projects yet.").child(div5().id("empty-add").text_color(t.foreground).cursor_pointer().on_click(() => run2("space.new")).child("New project"));
    return v_flex2().id("projects").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar().children(all.flatMap((project) => [
      this.projectRow(t, project),
      ...this.folded.has(project.id) ? [] : project.threads.map((thread) => this.threadRow(t, project, thread))
    ]));
  }
  render(t) {
    return v_flex2().size_full().bg(t.chrome).child(this.toolbar(t)).child(this.list(t));
  }
}

// src/topbar.ts
import { h_flex as h_flex5 } from "gpui-base";
import { div as div6, svg as svg3 } from "gpui-kit";
import { focused, layout, panes as panes2, run as run3, spaces as spaces2, window as window2 } from "herdr";
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
      return run3("layout.hide", { id: RIGHT_PANEL });
    run3("layout.select", { stack: RIGHT_PANEL, child });
    run3("layout.show", { id: RIGHT_PANEL });
  }, { on });
};
var topbar = (t) => {
  const w = window2();
  const root = layout();
  const space = spaces2().find((s) => s.active);
  const tab = space?.tabs.find((c) => c.active);
  const tabPanes = tab ? panes2().filter((p) => p.tab === tab.id) : [];
  const pane = focused()?.pane;
  const zoomed = Boolean(tab?.zoomed);
  const inset = w?.platform === "macos" && !w.fullscreen && find(root, "sidebar")?.hidden ? TRAFFIC_LIGHTS_INSET : 12;
  return h_flex5().size_full().min_w(0).pl(inset).pr(12).gap(12).items_center().bg(t.background).text_size(14).font_medium().child(h_flex5().flex_1().min_w(0).gap(8).items_center().when(space !== undefined, (el) => el.child(svg3(icon("folder")).size(14).flex_none().text_color(t.muted)).child(div6().flex_none().max_w(160).truncate().text_color(t.muted).child(space?.name)).child(div6().flex_none().text_color(t.dim).child("/")).child(div6().min_w(0).truncate().text_color(t.foreground).child(tab ? threadTitle(tab, tabPanes) : "")).when(Boolean(space?.branch), (el) => el.child(h_flex5().flex_none().h(20).px(6).gap(4).items_center().rounded(6).border(1).border_color(t.border).text_size(12).font_weight(400).text_color(t.muted).child(svg3(icon("git-branch")).size(12)).child(div6().max_w(160).truncate().child(space?.branch)))))).child(h_flex5().flex_none().gap(4).items_center().child(iconButton(t, "split", "terminal", () => run3("pane.split", { direction: "right", ...pane ? { pane } : {} }))).child(panelButton(t, root, "files", "files")).child(panelButton(t, root, "changes", "git-compare")).child(panelButton(t, root, "agents", "monitor")).child(iconButton(t, "zoom", zoomed ? "minus" : "square", () => run3("pane.zoom", pane ? { pane } : {}), {
    on: zoomed
  })).when(Boolean(w?.buttons), (el) => el.child(iconButton(t, "minimize", "minus", () => run3("window.minimize"))).child(iconButton(t, "maximize", "square", () => run3("window.maximize"))).child(iconButton(t, "close-window", "x", () => run3("window.close")))));
};

// src/main.ts
var PARTS = { header, footer, topbar };

class Vibest extends View {
  list;
  init(_props, cx) {
    const part = props()?.part ?? "";
    if (part === "agents")
      this.list = new AgentList(cx);
    else if (PARTS[part] === undefined)
      this.list = new ThreadList(cx);
  }
  close() {
    if (this.list instanceof AgentList)
      this.list.close();
  }
  render() {
    const t = theme();
    return this.list ? this.list.render(t) : PARTS[props()?.part ?? ""]?.(t);
  }
}
export {
  Vibest as default
};
