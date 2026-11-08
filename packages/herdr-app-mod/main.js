// packages/herdr-app-mod/src/mod.ts
import { h_flex, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import { appHome, exec, panes, run, terminals, theme } from "herdr";

// packages/herdr-app-mod/src/sessions.ts
var REFRESH_MS = 5000;
var SESSION_LABEL = "vibest.session";
var STRIPPED = ["VIBEST_SESSION_ID", "VIBEST_AGENT", "VIBEST_PROJECT_ID"];
var cliArgv = (command) => [
  ...STRIPPED.flatMap((name) => ["-u", name]),
  "vibest",
  command
];
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var text = (value) => typeof value === "string" ? value : undefined;
var coreAddress = (addressId) => {
  const at = addressId.lastIndexOf("@");
  return at < 0 ? addressId : addressId.slice(0, at);
};
var matchTerminal = (session, terminals) => {
  const want = coreAddress(session.addressId);
  if (want === "")
    return;
  const at = terminals.find((terminal) => terminal.address === want);
  if (at === undefined)
    return;
  const label = at.labels[SESSION_LABEL];
  if (label !== undefined && label !== "" && label !== session.id)
    return;
  return at;
};
var focusOf = (terminal, panes) => panes.some((pane) => pane.terminal === terminal) ? { command: "pane.focus", args: { terminal } } : { command: "terminal.keep", args: { terminal } };
var parseDaemonRunning = (stdout) => {
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
  return status === "running";
};
var sessionRow = (item) => {
  const id = text(item.id);
  const projectId = text(item.projectId);
  const address = isRecord(item.address) ? text(item.address.id) : undefined;
  if (id === undefined || projectId === undefined || address === undefined)
    return;
  return {
    id,
    projectId,
    name: text(item.name) ?? "",
    agent: text(item.agent) ?? "",
    harness: text(item.harness) ?? "",
    status: text(item.status) ?? "unknown",
    turnState: text(item.turnState) ?? "",
    runtime: text(item.runtime) ?? "",
    addressId: address,
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
var rowTitle = (row) => row.name || row.agent || row.id.slice(0, 8);
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

// packages/herdr-app-mod/src/mod.ts
var clip = (value) => {
  const trimmed = value.trim();
  return (trimmed === "" ? "vibest failed" : trimmed).slice(0, 180);
};

class VibestSessions extends View {
  sessions;
  note;
  refreshing;
  init(_props, cx) {
    this.sessions = [];
    this.note = "Loading…";
    this.refreshing = false;
    const pull = (current) => {
      current.spawn(async (spawned) => {
        await this.refresh(spawned);
      });
    };
    cx.timer.every(REFRESH_MS, pull);
    pull(cx);
  }
  async refresh(cx) {
    if (this.refreshing)
      return;
    this.refreshing = true;
    try {
      const cwd = appHome();
      const status = await exec("env", cliArgv("status"), { cwd });
      if (status.code !== 0)
        this.fail(clip(status.stderr || status.stdout || "vibest status failed"));
      else {
        const running = parseDaemonRunning(status.stdout);
        if (running === undefined)
          this.fail("vibest status was not understood");
        else if (!running)
          this.fail("vibestd is not running");
        else {
          const listed = await exec("env", cliArgv("ls"), { cwd });
          if (listed.code !== 0)
            this.fail(clip(listed.stderr || listed.stdout || "vibest ls failed"));
          else {
            const sessions = parseSessions(listed.stdout);
            if (sessions === undefined)
              this.fail("vibest ls was not understood");
            else {
              this.sessions = sessions;
              this.note = sessions.length === 0 ? "No live sessions" : "";
            }
          }
        }
      }
      cx.notify();
    } catch (error) {
      this.fail(clip(error instanceof Error ? error.message : "vibest could not be run"));
      cx.notify();
    } finally {
      this.refreshing = false;
    }
  }
  fail(note) {
    this.note = note;
    this.sessions = [];
  }
  sessionRow(colors, session, found, open) {
    const terminal = matchTerminal(session, found);
    const focus = terminal === undefined ? undefined : focusOf(terminal.address, open);
    const row = h_flex().id(`session-${session.id}`).gap(6).px(2).py(2).items_center().rounded(4).child(div().w(8).flex_none().text_color(colors[session.status] ?? colors.muted ?? "").child("●")).child(div().flex_1().truncate().text_color(colors.foreground ?? "").child(rowTitle(session))).child(div().flex_none().text_color(colors.dim ?? "").child(`${session.harness} ${statusText(session)}`)).child(div().flex_none().text_color(colors.dim ?? "").child(session.id.slice(0, 8)));
    if (focus === undefined)
      return row.child(div().flex_none().text_color(colors.dim ?? "").child("not in this window"));
    const action = focus;
    return row.cursor_pointer().hover((el) => el.bg(colors.hover ?? "")).on_click(() => {
      run(action.command, action.args);
    });
  }
  render(_cx) {
    const colors = theme();
    const found = coreTerminals(terminals());
    const open = modelPanes(panes());
    const rows = groupSessions(this.sessions).flatMap((group) => [
      div().id(`project-${group.projectId}`).truncate().text_color(colors.dim ?? "").child(projectHeading(group.projectId, group.label)),
      ...group.sessions.map((session) => this.sessionRow(colors, session, found, open))
    ]);
    return v_flex().id("vibest-sessions").size_full().bg(colors.surface ?? "").p(10).gap(6).text_size(12).overflow_y_scrollbar().child(div().font_semibold().text_color(colors.foreground ?? "").child("Vibest")).when(this.note !== "", (el) => el.child(div().text_color(colors.muted ?? "").child(this.note))).children(rows);
  }
}
export {
  VibestSessions as default
};
