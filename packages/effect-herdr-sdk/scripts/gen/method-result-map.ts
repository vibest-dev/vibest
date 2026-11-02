/**
 * Which result `type` tag each method returns.
 *
 * The schema does not carry this — `ResponseResult` is one flat union — so it
 * was established empirically against herdr 0.8.2 and is kept true by
 * `test/live/method-result-map.test.ts`. A method absent here is typed as the
 * loose `ResponseResult` union: a typing gap, never a runtime bug.
 */
export const METHOD_RESULT: Readonly<Record<string, string>> = {
  ping: "pong",
  "session.snapshot": "session_snapshot",
  "workspace.create": "workspace_created",
  "workspace.list": "workspace_list",
  "workspace.get": "workspace_info",
  "worktree.list": "worktree_list",
  "worktree.create": "worktree_created",
  "worktree.open": "worktree_opened",
  "worktree.remove": "worktree_removed",
  "tab.create": "tab_created",
  "tab.list": "tab_list",
  "tab.get": "tab_info",
  "agent.list": "agent_list",
  "agent.get": "agent_info",
  "agent.read": "pane_read",
  "agent.start": "agent_started",
  "agent.prompt": "agent_prompted",
  "agent.wait": "agent_info",
  "agent.view.set": "agent_view",
  "agent.view.clear": "agent_view",
  "pane.list": "pane_list",
  "pane.current": "pane_current",
  "pane.get": "pane_info",
  "pane.read": "pane_read",
  "pane.split": "pane_info",
  "events.subscribe": "subscription_started",
}
