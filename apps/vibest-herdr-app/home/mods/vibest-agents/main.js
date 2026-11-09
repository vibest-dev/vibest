// src/panel/agents/vibest-agents.ts
import { View } from "gpui-kit";

// src/shared/theme.ts
import { theme } from "herdr";
var themeColors = () => theme();

// src/panel/agents/view.ts
import { h_flex, v_flex } from "gpui-base";
import { div } from "gpui-kit";
import { appHome, exec } from "herdr";

// src/panel/agents/cli.ts
var STRIPPED = ["VIBEST_SESSION_ID", "VIBEST_AGENT", "VIBEST_PROJECT_ID"];
var LS_ARGV = [...STRIPPED.flatMap((name) => ["-u", name]), "vibest", "ls"];
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

// src/panel/agents/model.ts
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

// src/panel/agents/view.ts
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
      const listed = await exec("env", [...LS_ARGV], { cwd: appHome() });
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
    return v_flex().id("agents").size_full().bg(colors.background).border(1).border_color(colors.border).rounded(10).p(10).gap(6).text_size(12).overflow_y_scrollbar().child(h_flex().gap(8).items_center().child(div().font_semibold().text_color(colors.foreground).child("Agents")).child(div().flex_1()).child(div().id("agents-refresh").px(6).py(2).rounded(4).cursor_pointer().text_color(colors.foreground).hover((el) => el.bg(colors.hover)).on_click((_event, clicked) => {
      this.request(clicked);
    }).child("Refresh"))).when(this.note !== "", (el) => el.child(div().text_color(colors.muted).child(this.note))).when(this.asOf !== "", (el) => el.child(div().text_color(colors.dim).child(snapshotNote(this.asOf)))).children(rows);
  }
}

// src/panel/agents/vibest-agents.ts
class Agents extends View {
  list;
  init(_props, cx) {
    this.list = new AgentList(cx);
  }
  close() {
    this.list.close();
  }
  render() {
    return this.list.render(themeColors());
  }
}
export {
  Agents as default
};
