// packages/herdr-app-mod/src/mod.ts
import { h_flex, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { appHome, exec, panes, run, terminals, theme } from "herdr";

// packages/herdr-app-mod/src/sessions.ts
var SESSION_LABEL = "vibest.session";
var STRIPPED = ["VIBEST_SESSION_ID", "VIBEST_AGENT", "VIBEST_PROJECT_ID"];
var cliArgv = (command) => [
  ...STRIPPED.flatMap((name) => ["-u", name]),
  "vibest",
  command
];
var idlePull = () => ({ token: 0, closed: false, running: false, again: false });
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var text = (value) => typeof value === "string" ? value : undefined;
var parseOwnedAddress = (id) => {
  const at = id.indexOf("@");
  if (at <= 0 || at === id.length - 1)
    return;
  return { address: id.slice(0, at), socket: id.slice(at + 1) };
};
var placeSession = (session, terminals, panes) => {
  if (session.runtime !== "hc")
    return { action: "none", reason: `runtime ${session.runtime || "unknown"}` };
  if (session.machine !== "local")
    return { action: "none", reason: "on another machine" };
  if (session.socket === "" || session.coreAddress === "" || session.coreAddress.includes("/"))
    return { action: "none", reason: "no local terminal" };
  const matches = terminals.filter((terminal) => terminal.address === session.coreAddress && terminal.labels[SESSION_LABEL] === session.id);
  if (matches.length > 1)
    return { action: "none", reason: "ambiguous" };
  const found = matches[0];
  if (found === undefined)
    return { action: "none", reason: "not in this window" };
  if (!panes.some((pane) => pane.terminal === found.address))
    return { action: "none", reason: "no pane to focus" };
  return { action: "focus", terminal: found.address };
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
var coreTerminals = (value) => {
  if (!Array.isArray(value))
    return [];
  const terminals = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.address !== "string")
      continue;
    const labels = {};
    if (isRecord(item.labels)) {
      for (const [key, label] of Object.entries(item.labels))
        if (typeof label === "string")
          labels[key] = label;
    }
    terminals.push({ address: item.address, labels });
  }
  return terminals;
};
var modelPanes = (value) => {
  if (!Array.isArray(value))
    return [];
  const panes = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.pane !== "string")
      continue;
    panes.push({ pane: item.pane, terminal: typeof item.terminal === "string" ? item.terminal : null });
  }
  return panes;
};
var statusText = (row) => row.turnState === "" || row.turnState === "none" ? row.status : `${row.status}/${row.turnState}`;
var rowTitle = (row) => row.title || row.agent || row.id.slice(0, 8);
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

// packages/herdr-app-mod/src/mod.ts
var clip = (value) => {
  const trimmed = value.trim();
  return (trimmed === "" ? "vibest failed" : trimmed).slice(0, 180);
};
var failed = (value, fallback) => clip(value.stderr || value.stdout || fallback);

class VibestSessions extends View {
  sessions;
  note;
  asOf;
  pull;
  init(_props, cx) {
    this.sessions = [];
    this.note = "Reading vibestd…";
    this.asOf = "";
    this.pull = idlePull();
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
        note = failed(status, "vibest status failed");
      else {
        const verdict = statusVerdict(status.stdout);
        if (verdict === undefined)
          note = "vibest status was not understood";
        else if (!verdict.list)
          note = verdict.message;
        else {
          const listed = await exec("env", cliArgv("ls"), { cwd });
          if (listed.code !== 0)
            note = failed(listed, "vibest ls failed");
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
      note = clip(error instanceof Error ? error.message : "vibest could not be run");
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
    const place = placeSession(session, coreTerminals(terminals()), modelPanes(panes()));
    const row = h_flex().id(`session-${session.id}`).gap(6).px(2).py(2).items_center().rounded(4).child(div().flex_1().truncate().text_color(colors.foreground ?? "").child(rowTitle(session))).child(div().flex_none().text_color(colors.dim ?? "").child(`${session.harness} ${statusText(session)}`)).child(div().flex_none().text_color(colors.dim ?? "").child(session.id.slice(0, 8)));
    if (place.action === "none")
      return row.child(div().flex_none().text_color(colors.dim ?? "").child(place.reason));
    const terminal = place.terminal;
    return row.cursor_pointer().hover((el) => el.bg(colors.hover ?? "")).on_click(() => {
      run("pane.focus", { terminal });
    }).child(div().flex_none().text_color(colors.foreground ?? "").child("Focus"));
  }
  render(_cx) {
    const colors = theme();
    const rows = groupSessions(this.sessions).flatMap((group) => [
      div().id(`project-${group.projectId}`).truncate().text_color(colors.dim ?? "").child(projectHeading(group.projectId, group.label)),
      ...group.sessions.map((session) => this.sessionRow(colors, session))
    ]);
    return v_flex().id("vibest-sessions").size_full().bg(colors.surface ?? "").p(10).gap(6).text_size(12).overflow_y_scrollbar().child(h_flex().gap(8).items_center().child(div().font_semibold().text_color(colors.foreground ?? "").child("Vibest")).child(div().flex_1()).child(div().id("vibest-refresh").px(6).py(2).rounded(4).cursor_pointer().text_color(colors.foreground ?? "").hover((el) => el.bg(colors.hover ?? "")).on_click((_event, clicked) => {
      this.request(clicked);
    }).child("Refresh"))).when(this.note !== "", (el) => el.child(div().text_color(colors.muted ?? "").child(this.note))).when(this.asOf !== "", (el) => el.child(div().text_color(colors.dim ?? "").child(snapshotNote(this.asOf)))).children(rows);
  }
}
export {
  VibestSessions as default
};
