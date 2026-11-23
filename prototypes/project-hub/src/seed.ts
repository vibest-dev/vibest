import type { HubDatabase } from "./database.ts"
import { generateArchitectureScene } from "./excalidraw-templates.ts"
import type { Project } from "./schema.ts"

const DEMO_SPEC_MARKDOWN = `# Artifact Hub & Derived Triage Board — Architecture Contract

## 1. Motivation & Context

\`herdr-app\` renders terminal panes natively on GPUI without a DOM or WebView. When parallel agent workstreams produce **multi-variant HTML prototypes**, **Excalidraw system diagrams**, or **long architecture specs**, reviewing them in terminal scrollback causes context loss and prose back-and-forth.

The **Bun Project & Artifact Hub** pairs directly with \`vibestd\` as a zero-cloud local web studio:

- **2 Core Primitives**: \`Task\` (parallel workstream) and \`Artifact\` (versioned deliverable + review gate).
- **1 Pure Derived Triage Queue**: \`Needs You\` is computed strictly from \`Artifact(reviewStatus = 'requested')\` + \`Session(status = 'blocked')\` — zero duplicated state columns.

## 2. End-to-End Review & Wake-Up Flow

\`\`\`mermaid
sequenceDiagram
    participant Worker as Worker Session
    participant Hub as Bun Artifact Hub (SQLite)
    participant Browser as Owner Browser Studio
    participant Entry as Entry Coordinator

    Worker->>Hub: artifact put html prototype.html --request-review
    Hub-->>Browser: WebSocket push (Needs You +1)
    Browser->>Browser: Pick DOM element #1 + Box-select region #2
    Browser->>Hub: Submit Review (Approve / Request Changes)
    Hub->>Hub: Append artifact.reviewed fact & clear Needs You
    Hub-->>Entry: Deliver <vibest-artifact-review> with exact anchors
\`\`\`

## 3. Event Ledger & Storage Contract

| Table | Mutability | Primary Key | Responsibility |
| :--- | :--- | :--- | :--- |
| \`event\` | Append-only (\`RAISE(ABORT)\` trigger) | \`seq\` | Canonical audit trail of all project, task, comment, and review facts |
| \`task\` | Rebuilt projection | \`id\` | Active/done parallel workstreams with branch, PR, and session links |
| \`artifact\` | Rebuilt projection | \`id\` | Deliverable metadata, version history, review gate status, structured questions |
| \`comment_thread\` | Rebuilt projection | \`id\` | Numbered pins (\`#1\`, \`#2\`) with typed DOM, Region, Whiteboard, or Quote anchors |

## 4. Routing Rules on Verdict

1. **\`changes_requested\`**: Routes directly to \`authorSessionId\` (falling back to \`entrySessionId\`) with exact DOM selectors, normalized bounding boxes, Excalidraw element IDs, and quoted spec spans so the author publishes \`v(N+1)\`.
2. **\`approved\`**: Freezes the approved version record and notifies \`entrySessionId\` so downstream merge or implementation steps proceed immediately.
`

const DEMO_HTML_VARIANT_A = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Option A: Split queue</title>
  <style>
    @font-face { font-family: "IBM Plex Sans"; font-weight: 400 700; font-display: swap; src: url("/fonts/ibm-plex-sans-latin.woff2") format("woff2"); }
    @font-face { font-family: "IBM Plex Mono"; font-weight: 400; font-display: swap; src: url("/fonts/ibm-plex-mono-400-latin.woff2") format("woff2"); }
    :root { --ground: #f6f6f3; --rail: #ededea; --sheet: #fdfdfb; --hover: #e6e6e2; --rule: #deddd8; --rule-strong: #c4c2bb; --ink: #1a1917; --ink-2: #4d4a44; --ink-3: #66625a; --signal: #b3401d; --signal-wash: #f7e3da; --ok: #2d6a3e; --warn: #8a5800; }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body { background: var(--ground); color: var(--ink); font: 14px/1.5 "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
    h1, h2, h3 { margin: 0; text-wrap: balance; }
    p { margin: 0; text-wrap: pretty; }
    .mono { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-size: 12px; }
    ::selection { background: var(--signal-wash); }
    button { font: inherit; cursor: pointer; border-radius: 6px; padding: 7px 14px; font-weight: 600; border: 1px solid var(--rule-strong); background: var(--sheet); color: var(--ink); }
    button:hover { background: var(--hover); }
    button:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
    .primary { background: var(--ink); border-color: var(--ink); color: var(--sheet); }
    .primary:hover { background: var(--ink-2); }
    .status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; }
    .status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .attention { color: var(--signal); }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .muted { color: var(--ink-3); }
    body { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
    aside { background: var(--rail); border-right: 1px solid var(--rule); padding: 20px 12px; display: flex; flex-direction: column; gap: 20px; }
    .brand { display: flex; align-items: center; justify-content: space-between; padding: 0 8px; font-weight: 700; }
    .needs { color: var(--signal); font-size: 12px; font-weight: 700; }
    nav { display: flex; flex-direction: column; gap: 2px; }
    .nav-item { display: flex; justify-content: space-between; padding: 8px 10px; border-radius: 6px; color: var(--ink-2); cursor: pointer; }
    .nav-item:hover { background: var(--hover); color: var(--ink); }
    .nav-item.active { background: var(--sheet); color: var(--ink); font-weight: 600; box-shadow: 0 1px 2px rgb(26 25 23 / 0.06); }
    .nav-item .count { color: var(--ink-3); font-size: 12px; }
    main { padding: 32px 40px 48px; display: flex; flex-direction: column; gap: 28px; min-width: 0; }
    header { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding-bottom: 18px; border-bottom: 1px solid var(--ink); flex-wrap: wrap; }
    header h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.015em; }
    header p { margin-top: 4px; color: var(--ink-2); }
    .actions { display: flex; gap: 8px; }
    #telemetry-strip { display: flex; gap: 32px; margin: 0; flex-wrap: wrap; }
    #telemetry-strip div { display: flex; flex-direction: column-reverse; gap: 2px; }
    #telemetry-strip dt { color: var(--ink-2); font-size: 12px; }
    #telemetry-strip dd { margin: 0; font-size: 18px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 12px; font-weight: 600; color: var(--ink-2); padding: 8px 10px; border-bottom: 1px solid var(--ink); }
    td { padding: 12px 10px; border-bottom: 1px solid var(--rule); vertical-align: top; }
    td.mono, td.num, td .status { white-space: nowrap; }
    tbody tr { cursor: pointer; }
    tbody tr:hover td { background: var(--sheet); }
    tbody tr.selected td { background: var(--sheet); }
    tbody tr.selected td:first-child { color: var(--signal); font-weight: 700; }
    .key { width: 40px; color: var(--ink-3); }
    .item-title { font-weight: 600; }
    .item-sub { color: var(--ink-2); margin-top: 2px; }
    .num { text-align: right; }
    .detail { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 32px; }
    .detail h2 { font-size: 15px; font-weight: 600; margin-bottom: 10px; }
    .diff { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--rule); }
    .diff li { display: grid; grid-template-columns: minmax(0, 1fr) 56px 56px; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--rule); }
    .add { color: var(--ok); text-align: right; }
    .del { color: var(--signal); text-align: right; }
    .verdicts { list-style: none; margin: 0; padding: 0; }
    .verdicts li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--rule); }
    .hint { color: var(--ink-3); font-size: 12px; }
  </style>
</head>
<body>
  <aside id="compact-sidebar">
    <div class="brand">
      <span>vibest</span>
      <span class="needs" id="sidebar-needs-badge">3 need you</span>
    </div>
    <nav>
      <div class="nav-item active" data-nav="triage"><span>Needs you</span><span class="count">3</span></div>
      <div class="nav-item" data-nav="workstreams"><span>Workstreams</span><span class="count">3</span></div>
      <div class="nav-item" data-nav="sessions"><span>Sessions</span><span class="count">4</span></div>
      <div class="nav-item" data-nav="knowledge"><span>Memory</span><span class="count">6</span></div>
    </nav>
  </aside>
  <main>
    <header>
      <div>
        <h1>Needs you</h1>
        <p>Move with j and k, open with Enter. Gates and the head commit sit beside each item.</p>
      </div>
      <div class="actions">
        <button id="batch-defer-btn">Defer non-blocking</button>
        <button class="primary" id="approve-merge-btn">Approve and merge</button>
      </div>
    </header>

    <dl id="telemetry-strip">
      <div><dt>Harness slots in use</dt><dd>3 of 3</dd></div>
      <div><dt>Waiting on review</dt><dd>3</dd></div>
      <div><dt>Median turn</dt><dd>42 s</dd></div>
    </dl>

    <table id="triage-queue">
      <thead>
        <tr><th class="key">Key</th><th>Item</th><th>Head</th><th>Gates</th><th class="num">Waiting</th></tr>
      </thead>
      <tbody>
        <tr class="selected" id="pr-613-gate-card">
          <td class="key mono">1</td>
          <td><div class="item-title">Team CLI roster and slot guard</div><div class="item-sub">PR #613 · ready to merge into main</div><div class="item-sub mono">feat/team-cli-roster</div></td>
          <td class="mono">8f41c92b</td>
          <td><span class="status ok">4 of 4 passed</span></td>
          <td class="num">18 min</td>
        </tr>
        <tr id="queue-row-spec">
          <td class="key mono">2</td>
          <td><div class="item-title">Artifact hub contract</div><div class="item-sub">Spec · 2 open decisions</div><div class="item-sub mono">feat/project-hub-prototype</div></td>
          <td class="mono">4c07e1aa</td>
          <td><span class="status muted">No gates</span></td>
          <td class="num">1 h 05</td>
        </tr>
        <tr id="queue-row-racknerd">
          <td class="key mono">3</td>
          <td><div class="item-title">racknerd-outbox-probe is blocked</div><div class="item-sub">Asks to add a known_hosts entry for 198.51.100.42</div><div class="item-sub mono">feat/outbox-reconnect</div></td>
          <td class="mono">b19d3f60</td>
          <td><span class="status attention">Blocked</span></td>
          <td class="num">2 h 40</td>
        </tr>
      </tbody>
    </table>

    <section class="detail">
      <div>
        <h2>feat/team-cli-roster at 8f41c92b</h2>
        <ul class="diff" id="diff-summary">
          <li><span class="mono">packages/cli/src/commands/run.ts</span><span class="mono add">+142</span><span class="mono del">−38</span></li>
          <li><span class="mono">packages/core/src/session/slots.ts</span><span class="mono add">+96</span><span class="mono del">−4</span></li>
          <li><span class="mono">tools/e2e/checks/team.ts</span><span class="mono add">+210</span><span class="mono del">−0</span></li>
        </ul>
        <p class="hint" style="margin-top:10px">Sign-off records the verdict and runs gh pr merge 613 with --match-head-commit 8f41c92b.</p>
        <p style="margin-top:14px"><button id="card-signoff-btn">Sign off PR #613</button></p>
      </div>
      <div>
        <h2>Recent verdicts</h2>
        <ul class="verdicts" id="verdict-log">
          <li><span>Memory index cleanup</span><span class="status ok">Approved</span></li>
          <li><span>Hook re-entry guard</span><span class="status warn">Changes</span></li>
          <li><span>Plugin rescan loop</span><span class="status ok">Approved</span></li>
        </ul>
      </div>
    </section>
  </main>
  <script>
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
        el.classList.add('active');
      });
    });
    const rows = Array.from(document.querySelectorAll('#triage-queue tbody tr'));
    const select = (row) => { rows.forEach((r) => r.classList.remove('selected')); row.classList.add('selected'); };
    rows.forEach((row) => row.addEventListener('click', () => select(row)));
    document.addEventListener('keydown', (ev) => {
      const index = rows.findIndex((r) => r.classList.contains('selected'));
      if (ev.key === 'j' && rows[index + 1]) select(rows[index + 1]);
      if (ev.key === 'k' && rows[index - 1]) select(rows[index - 1]);
    });
  </script>
</body>
</html>`

const DEMO_HTML_VARIANT_B = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Option B: Ledger stream</title>
  <style>
    @font-face { font-family: "IBM Plex Sans"; font-weight: 400 700; font-display: swap; src: url("/fonts/ibm-plex-sans-latin.woff2") format("woff2"); }
    @font-face { font-family: "IBM Plex Mono"; font-weight: 400; font-display: swap; src: url("/fonts/ibm-plex-mono-400-latin.woff2") format("woff2"); }
    :root { --ground: #f6f6f3; --rail: #ededea; --sheet: #fdfdfb; --hover: #e6e6e2; --rule: #deddd8; --rule-strong: #c4c2bb; --ink: #1a1917; --ink-2: #4d4a44; --ink-3: #66625a; --signal: #b3401d; --signal-wash: #f7e3da; --ok: #2d6a3e; --warn: #8a5800; }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body { background: var(--ground); color: var(--ink); font: 14px/1.5 "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
    h1, h2, h3 { margin: 0; text-wrap: balance; }
    p { margin: 0; text-wrap: pretty; }
    .mono { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-size: 12px; }
    ::selection { background: var(--signal-wash); }
    button { font: inherit; cursor: pointer; border-radius: 6px; padding: 7px 14px; font-weight: 600; border: 1px solid var(--rule-strong); background: var(--sheet); color: var(--ink); }
    button:hover { background: var(--hover); }
    button:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
    .primary { background: var(--ink); border-color: var(--ink); color: var(--sheet); }
    .primary:hover { background: var(--ink-2); }
    .status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; white-space: nowrap; }
    .status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .attention { color: var(--signal); }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .muted { color: var(--ink-3); }
    body { display: grid; grid-template-rows: auto 1fr; min-height: 100vh; }
    .topbar { display: flex; align-items: center; gap: 20px; padding: 12px 24px; border-bottom: 1px solid var(--rule); background: var(--sheet); flex-wrap: wrap; }
    .topbar strong { font-size: 15px; }
    .command { flex: 1; max-width: 420px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--rule-strong); border-radius: 6px; padding: 6px 10px; background: var(--ground); }
    .command input { flex: 1; border: none; background: transparent; font: inherit; color: var(--ink); outline: none; caret-color: var(--signal); }
    .command input::placeholder { color: var(--ink-3); }
    .command kbd { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-size: 12px; color: var(--ink-2); border: 1px solid var(--rule); border-radius: 4px; padding: 0 5px; }
    .tabs { display: flex; gap: 2px; background: var(--rail); border: 1px solid var(--rule); border-radius: 8px; padding: 3px; }
    .tab { border: 1px solid transparent; background: transparent; padding: 5px 11px; border-radius: 5px; font-size: 12px; color: var(--ink-2); }
    .tab.active { background: var(--sheet); border-color: var(--rule); color: var(--ink); }
    .workspace { display: grid; grid-template-columns: minmax(0, 1fr) 340px; min-height: 0; }
    #left-lane-list { padding: 28px 32px; }
    #left-lane-list h2 { font-size: 18px; font-weight: 600; padding-bottom: 10px; border-bottom: 1px solid var(--ink); }
    .event { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 16px; align-items: baseline; padding: 14px 8px; border-bottom: 1px solid var(--rule); cursor: pointer; }
    .event:hover { background: var(--sheet); }
    .event.selected { background: var(--sheet); }
    .event.selected .seq { color: var(--signal); font-weight: 600; }
    .stamp { display: flex; flex-direction: column; color: var(--ink-3); }
    .event-title { font-weight: 600; }
    .event-sub { color: var(--ink-2); margin-top: 2px; }
    #right-quick-preview { border-left: 1px solid var(--rule); background: var(--rail); padding: 28px 24px; display: flex; flex-direction: column; gap: 16px; }
    #right-quick-preview h2 { font-size: 15px; font-weight: 600; }
    #right-quick-preview h3 { font-size: 14px; font-weight: 600; margin-top: 8px; }
    .facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; }
    .facts dt { color: var(--ink-2); font-size: 12px; }
    .facts dd { margin: 0; }
    .choice { display: flex; gap: 10px; align-items: flex-start; padding: 9px 10px; border: 1px solid var(--rule); border-radius: 6px; background: var(--sheet); }
    .choice input { accent-color: var(--ink); margin-top: 3px; }
    .choice .rec { display: block; color: var(--ok); font-size: 12px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="topbar">
    <strong>vibest-core</strong>
    <label class="command"><input id="command-input" placeholder="Jump to a session, artifact, or branch" aria-label="Command" /><kbd>⌘K</kbd></label>
    <div class="tabs" role="tablist">
      <button class="tab active" id="tab-needs-you" role="tab" aria-selected="true">Needs you · 3</button>
      <button class="tab" id="tab-active-lanes" role="tab" aria-selected="false">In progress · 3</button>
    </div>
  </div>
  <div class="workspace">
    <section id="left-lane-list">
      <h2>Ledger, newest first</h2>
      <div class="event selected" id="split-item-spec">
        <span class="mono stamp"><span class="seq">#1284</span><span>14:32</span></span>
        <div><div class="event-title">Artifact hub contract v1 asks for review</div><div class="event-sub">2 open decisions · from artifact-hub-author on agy</div></div>
        <span class="status attention">Decision</span>
      </div>
      <div class="event" id="split-item-whiteboard">
        <span class="mono stamp"><span class="seq">#1279</span><span>14:05</span></span>
        <div><div class="event-title">Service topology whiteboard saved</div><div class="event-sub">5 nodes · 1 comment on the event ledger node</div></div>
        <span class="status attention">Review</span>
      </div>
      <div class="event" id="split-item-verify">
        <span class="mono stamp"><span class="seq">#1271</span><span>13:48</span></span>
        <div><div class="event-title">PR #613 gates finished at 8f41c92b</div><div class="event-sub">build, typecheck, unit, and e2e passed in 58.6 s</div></div>
        <span class="status ok">Passed</span>
      </div>
      <div class="event" id="split-item-blocked">
        <span class="mono stamp"><span class="seq">#1266</span><span>13:20</span></span>
        <div><div class="event-title">racknerd-outbox-probe stopped for confirmation</div><div class="event-sub">Wants a known_hosts entry for 198.51.100.42</div></div>
        <span class="status attention">Blocked</span>
      </div>
    </section>
    <aside id="right-quick-preview">
      <h2>Artifact hub contract</h2>
      <dl class="facts">
        <dt>Version</dt><dd class="mono">v1</dd>
        <dt>Author</dt><dd>artifact-hub-author</dd>
        <dt>Branch</dt><dd class="mono">feat/project-hub-prototype</dd>
      </dl>
      <h3>How should a verdict reach the session?</h3>
      <label class="choice"><input type="radio" name="delivery" checked /><span>Preview, then send when I opt in<span class="rec">Recommended</span></span></label>
      <label class="choice"><input type="radio" name="delivery" /><span>Send as soon as I decide</span></label>
      <button class="primary" id="split-drawer-approve-btn">Approve v1</button>
    </aside>
  </div>
  <script>
    const events = Array.from(document.querySelectorAll('.event'));
    events.forEach((el) => el.addEventListener('click', () => {
      events.forEach((n) => n.classList.remove('selected'));
      el.classList.add('selected');
    }));
    const tabs = Array.from(document.querySelectorAll('.tab'));
    tabs.forEach((tab) => tab.addEventListener('click', () => {
      tabs.forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
    }));
  </script>
</body>
</html>`

const DEMO_VERIFY_MARKDOWN = `## Verification Summary — PR #613

All deterministic gates and live multi-agent team roster checks passed on \`feat/team-cli-roster\`.

- **Unit & FakeGit suite**: 418/418 passed with \`TURBO_FORCE=true\`.
- **Live E2E (\`team\` + \`concurrency\` areas)**: Verified 3-agent cap holds new process spawns in memory while allowing running sessions to exchange messages freely.
`

const DEMO_APPROVED_MEMORY_DOC = `# Curated MEMORY.md Index Consolidation

Merged 9 fragmented harness notes into topic-aligned files under \`memories/\`:

1. \`claude-cli-and-runtime.md\` + \`claude-plugin-hooks.md\`
2. \`core-ledger-and-db.md\` (append-only invariants, \`event.position\`, \`findSession\` live-only)
3. \`e2e-runner-and-verify.md\` (slot pool, curl/npm legs, \`--no-cache\` rules)
`

export function seedDefaultDemoProject(hubDb: HubDatabase): Project {
  const existing = hubDb.listProjects()

  if (existing.length > 0 && existing[0] !== undefined) {
    return existing[0]
  }

  const project = hubDb.createProject({
    id: "proj-vibest-core",
    name: "vibest-core",
    description: "Event-sourced multi-agent runtime, CLI harnesses, and interactive Artifact Hub",
    repoPath: "/Users/dinq/.vibest/worktrees/vibest/0484",
    entrySessionId: "ses-entry-coord",
  })

  hubDb.writeKnowledgeFile(
    project.id,
    "preferences.md",
    [
      "# Project Workflow Preferences",
      "",
      "- Parallel work cap: at most **3 live harness processes** at once on this Mac; queue additional runs.",
      "- Harness routing: **Claude Opus** for architecture & concurrency; **agy Gemini 4** for deep research & reviews; **Cursor** for mechanical edits.",
      "- Database stays event-sourced: append-only `event` ledger + deterministically rebuilt read-model tables.",
      "- `Needs You` on the Board is strictly derived from `Artifact(reviewStatus = 'requested')` + `Session(status = 'blocked')`.",
      "- Keep implementations crisp and fail-fast; avoid speculative abstractions or code comments.",
      "",
    ].join("\n"),
  )

  hubDb.writeKnowledgeFile(
    project.id,
    "memories/MEMORY.md",
    [
      "# Project Memory Index",
      "",
      "- `memories/core-ledger-and-db.md` — Append-only SQLite ledger triggers, projection rebuilds, and read-only external DB rules",
      "- `memories/agent-orchestration.md` — 3-agent concurrency cap, entry coordinator routing, and artifact review feedback loops",
      "",
    ].join("\n"),
  )

  hubDb.writeKnowledgeFile(
    project.id,
    "memories/core-ledger-and-db.md",
    [
      "# Core Ledger & Database Invariants",
      "",
      "- Every state transition appends an immutable JSON fact to `event` inside one SQLite transaction with its projection write.",
      "- External `vibest.db` inspections open strictly `{ readonly: true }` with `PRAGMA query_only = ON`.",
      "",
    ].join("\n"),
  )

  hubDb.writeKnowledgeFile(
    project.id,
    "memories/agent-orchestration.md",
    [
      "# Multi-Agent Orchestration Rules",
      "",
      "- When `Request Changes` is submitted on an Artifact, deliver `<vibest-artifact-review>` to `authorSessionId` so the worker publishes `v(N+1)`.",
      "- When `Approve` is submitted, notify `entrySessionId` with the frozen artifact version.",
      "",
    ].join("\n"),
  )

  hubDb.writeKnowledgeFile(project.id, "docs/design/artifact-hub-architecture.md", DEMO_SPEC_MARKDOWN)

  hubDb.writeKnowledgeFile(
    project.id,
    "docs/features/board-triage.md",
    [
      "# Feature: Derived Triage Board (B1–B4)",
      "",
      "- **B1 (`Needs You` Derivation)**: Shows every artifact with `reviewStatus = 'requested'` and every session with `status = 'blocked'`.",
      "- **B2 (`DOM & Region Visual Commenting`)**: HTML prototypes support element-picker pins (`#1`) and box/circle region callouts (`#2`) persisted across reloads.",
      "- **B3 (`Excalidraw Whiteboard`)**: Interactive `.excalidraw` canvas with auto-save and element-pinned threads.",
      "- **B4 (`Spec Questions & Verdict Payload`)**: Answering structured choices and clicking `Approve` clears `Needs You` and builds `<vibest-artifact-review>`.",
      "",
    ].join("\n"),
  )

  const taskHub = hubDb.createTask({
    id: "task-artifact-hub",
    projectId: project.id,
    title: "Native Project & Interactive Artifact Hub",
    status: "active",
    summary: "Spec, dual-variant HTML triage prototype, and Excalidraw architecture diagram ready for owner review.",
    branch: "feat/project-hub-prototype",
    sessionIds: ["ses-entry-coord", "ses-ui-worker"],
  })

  const taskPr613 = hubDb.createTask({
    id: "task-pr-613",
    projectId: project.id,
    title: "PR #613 Team CLI Roster & Concurrency Guard",
    status: "active",
    summary: "All 4 CI & E2E gates green; awaiting merge sign-off card approval.",
    branch: "feat/team-cli-roster",
    prUrl: "https://github.com/vibest-dev/vibest/pull/613",
    sessionIds: ["ses-team-worker"],
  })

  const taskInbox = hubDb.createTask({
    id: "task-inbox-ledger",
    projectId: project.id,
    title: "Cross-Machine Outbox & Credential Rotation",
    status: "active",
    summary: "Worker paused on SSH host key confirmation for racknerd staging node.",
    branch: "feat/outbox-reconnect",
    sessionIds: ["ses-blocked-racknerd"],
  })

  const taskMemoryDone = hubDb.createTask({
    id: "task-memory-prune",
    projectId: project.id,
    title: "Curated MEMORY.md Topic Consolidation",
    status: "done",
    summary: "Consolidated 27 memory notes into topic files and verified zero stale rules.",
    branch: "chore/prune-memories",
    sessionIds: ["ses-doc-curator"],
  })

  hubDb.upsertSession({
    id: "ses-entry-coord",
    projectId: project.id,
    taskId: taskHub.id,
    name: "coordinator",
    agent: "default",
    harness: "claude",
    model: "claude-opus-4-6",
    directory: "/Users/dinq/.vibest/worktrees/vibest/0484",
    status: "idle",
  })

  hubDb.upsertSession({
    id: "ses-ui-worker",
    projectId: project.id,
    taskId: taskHub.id,
    parentSessionId: "ses-entry-coord",
    name: "artifact-hub-author",
    agent: "coder",
    harness: "agy",
    model: "gemini-4-carbon-high",
    directory: "/Users/dinq/.vibest/worktrees/vibest/0484/prototypes/project-hub",
    status: "running",
  })

  hubDb.upsertSession({
    id: "ses-team-worker",
    projectId: project.id,
    taskId: taskPr613.id,
    parentSessionId: "ses-entry-coord",
    name: "team-cli-verifier",
    agent: "verifier",
    harness: "claude",
    model: "claude-sonnet-4-6",
    directory: "/Users/dinq/.vibest/worktrees/vibest/0481",
    status: "idle",
  })

  hubDb.upsertSession({
    id: "ses-blocked-racknerd",
    projectId: project.id,
    taskId: taskInbox.id,
    parentSessionId: "ses-entry-coord",
    name: "racknerd-outbox-probe",
    agent: "coder",
    harness: "pi",
    model: "tcpa/glm-5.3",
    directory: "/Users/dinq/.vibest/worktrees/vibest/0482",
    status: "blocked",
    blockedReason: "Needs owner confirmation before adding SSH known_hosts entry for staging peer 198.51.100.42",
  })

  hubDb.upsertSession({
    id: "ses-doc-curator",
    projectId: project.id,
    taskId: taskMemoryDone.id,
    parentSessionId: "ses-entry-coord",
    name: "memory-curator",
    agent: "researcher",
    harness: "agy",
    model: "gemini-4-carbon-high",
    directory: "/Users/dinq/.vibest/projects/077fb15b-4123-4fb3-8365-990f3198d1d6",
    status: "ended",
  })

  const specArtifact = hubDb.putArtifact({
    id: "art-hub-spec",
    projectId: project.id,
    taskId: taskHub.id,
    slug: "artifact-hub-contract",
    title: "Artifact Hub & Derived Triage Contract",
    kind: "markdown",
    summary: "Core 2-primitive model, Mermaid review sequence, and structured routing decisions.",
    content: DEMO_SPEC_MARKDOWN,
    reviewStatus: "requested",
    authorSessionId: "ses-ui-worker",
    questions: [
      {
        id: "delivery-mode",
        question: "How should Approve / Request Changes deliver <vibest-artifact-review> to sessions?",
        context:
          "Determines whether review verdicts auto-wake running sessions or stay copy-on-demand during prototype review.",
        multiSelect: false,
        options: [
          {
            id: "opt-in-send",
            label: "Preview payload + explicit opt-in vibest send",
            description: "Safe for demo & browsing; never spams live terminals unless toggled on.",
            recommended: true,
          },
          {
            id: "always-auto-send",
            label: "Always auto-send immediately on verdict",
            description: "Zero-click wake-up, requires active target session in vibestd.",
          },
        ],
      },
      {
        id: "enabled-surfaces",
        question: "Which interactive annotation surfaces ship in v1?",
        context: "Select all artifact viewers to enable in the default studio.",
        multiSelect: true,
        options: [
          {
            id: "html-dom-region",
            label: "HTML DOM Element Picker + Region Box/Circle Select",
            recommended: true,
          },
          {
            id: "excalidraw-whiteboard",
            label: "Excalidraw Whiteboard + Element-Pinned Threads",
            recommended: true,
          },
          {
            id: "markdown-quote-verify",
            label: "Markdown Inline Quote Comments + PR Verify Cards",
            recommended: true,
          },
        ],
      },
    ],
  })

  hubDb.addCommentThread({
    artifactId: specArtifact.id,
    author: "coordinator",
    body: "Verify that Needs You never introduces a status column on Task — keeping Task strictly active | done | cancelled prevents drift.",
    anchor: {
      kind: "quote",
      quote: "1 Pure Derived Triage Queue: Needs You is computed strictly from Artifact(reviewStatus = 'requested')",
      blockHeading: "1. Motivation & Context",
    },
  })

  const htmlArtifact = hubDb.putArtifact({
    id: "art-triage-ui",
    projectId: project.id,
    taskId: taskHub.id,
    slug: "triage-ui-prototype",
    title: "Triage Workspace Prototype (Option A vs Option B)",
    kind: "html",
    summary:
      "Two triage layouts to compare: a keyboard split queue (Option A) and a ledger stream with an inspector (Option B).",
    content: DEMO_HTML_VARIANT_A,
    reviewStatus: "requested",
    authorSessionId: "ses-ui-worker",
    extraFiles: [
      { fileName: "variant-a.html", content: DEMO_HTML_VARIANT_A },
      { fileName: "variant-b.html", content: DEMO_HTML_VARIANT_B },
    ],
    metadata: {
      selectedVariantId: "option-a",
      variants: [
        {
          id: "option-a",
          label: "Option A: Split queue",
          description: "Dense keyboard queue with head commits, gate results, and the selected diff",
          fileName: "variant-a.html",
        },
        {
          id: "option-b",
          label: "Option B: Ledger stream",
          description: "Command bar over the event ledger, with an inspector for the selected item",
          fileName: "variant-b.html",
        },
      ],
    },
    questions: [
      {
        id: "preferred-layout",
        question: "Which visual direction should we adopt for the Triage Workspace?",
        multiSelect: false,
        options: [
          {
            id: "option-a",
            label: "Option A: Split queue",
            description: "Fastest sign-off: j and k through the queue with gates and diff in view.",
            recommended: true,
          },
          {
            id: "option-b",
            label: "Option B: Ledger stream",
            description: "Every fact in order, with decisions answered in the inspector.",
          },
        ],
      },
    ],
  })

  hubDb.addCommentThread({
    artifactId: htmlArtifact.id,
    author: "owner-preview",
    body: "Name the PR and head commit on this button before it merges, e.g. Approve and merge #613 at 8f41c92b.",
    anchor: {
      kind: "dom",
      variantId: "option-a",
      selector: "#approve-merge-btn",
      tagName: "button",
      textPreview: "Approve and merge",
      xRatio: 0.84,
      yRatio: 0.08,
      wRatio: 0.13,
      hRatio: 0.05,
    },
  })

  const whiteboardArtifact = hubDb.putArtifact({
    id: "art-arch-whiteboard",
    projectId: project.id,
    taskId: taskHub.id,
    slug: "vibest-hub-topology",
    title: "vibestd ↔ SQLite Ledger ↔ Artifact Hub Whiteboard",
    kind: "whiteboard",
    summary: "Interactive Excalidraw topology diagram — drag nodes, sketch new flows, or pin comments to elements.",
    content: generateArchitectureScene("vibest-architecture"),
    reviewStatus: "requested",
    authorSessionId: "ses-ui-worker",
  })

  hubDb.addCommentThread({
    artifactId: whiteboardArtifact.id,
    author: "architect",
    body: "External vibest.db reads must stay strictly readonly=true + PRAGMA query_only=ON; hub writes only to its own hub.sqlite.",
    anchor: {
      kind: "whiteboard",
      elementIds: ["node-ledger"],
      elementLabels: ["SQLite Event Ledger (Append-Only Facts + Read Model)"],
      x: 520,
      y: 220,
    },
  })

  hubDb.putArtifact({
    id: "art-pr-613-verify",
    projectId: project.id,
    taskId: taskPr613.id,
    slug: "pr-613-merge-verify",
    title: "PR #613 merge sign-off: team CLI and slot guard",
    kind: "verify",
    summary: "All build, typecheck, unit, and live E2E gates green on head 8f41c92b.",
    content: DEMO_VERIFY_MARKDOWN,
    reviewStatus: "requested",
    authorSessionId: "ses-team-worker",
    metadata: {
      verifyCard: {
        goal: "Ship `vibest run --team` roster messaging and enforce the per-machine live process cap in one SQLite transaction.",
        branch: "feat/team-cli-roster",
        commitSha: "8f41c92b",
        prUrl: "https://github.com/vibest-dev/vibest/pull/613",
        gates: [
          {
            id: "gate-build",
            name: "pnpm build",
            command: "pnpm build",
            status: "passed",
            durationMs: 4210,
            detail: "Built @vibest/cli and 4 harness plugins",
          },
          {
            id: "gate-typecheck",
            name: "TURBO_FORCE=true pnpm typecheck",
            command: "TURBO_FORCE=true pnpm typecheck",
            status: "passed",
            durationMs: 6840,
            detail: "0 TypeScript or oxlint errors across 27 packages",
          },
          {
            id: "gate-unit",
            name: "TURBO_FORCE=true pnpm test",
            command: "TURBO_FORCE=true pnpm test",
            status: "passed",
            durationMs: 9120,
            detail: "418 unit tests + oxlint rule fixtures green",
          },
          {
            id: "gate-e2e",
            name: "pnpm e2e team concurrency --no-cache",
            command: "pnpm e2e team concurrency --no-cache",
            status: "passed",
            durationMs: 38400,
            detail: "T1–T4 & C1–C3 verified in isolated VIBEST_HOME",
          },
        ],
        risks: [
          "Waiting list lives in memory by design: a vibestd restart marks queued unstarted runs as not_started and notifies creator once.",
        ],
        unverified: ["10-machine remote peer mesh stress test (scheduled separately on racknerd)."],
        authorizedCommand: "gh pr merge 613 -R vibest-dev/vibest --merge --match-head-commit 8f41c92b",
      },
    },
    questions: [
      {
        id: "merge-authorization",
        question: "Authorize merging PR #613 at verified head 8f41c92b?",
        multiSelect: false,
        options: [
          {
            id: "merge-now",
            label: "Yes, merge into main with --match-head-commit 8f41c92b",
            recommended: true,
          },
          {
            id: "hold-racknerd",
            label: "Hold until multi-machine racknerd stress check completes",
          },
        ],
      },
    ],
  })

  hubDb.putArtifact({
    id: "art-memory-report",
    projectId: project.id,
    slug: "curated-memory-index",
    title: "Curated MEMORY.md Consolidation Report",
    kind: "markdown",
    summary: "Approved standalone documentation cleanup report.",
    content: DEMO_APPROVED_MEMORY_DOC,
    reviewStatus: "approved",
    authorSessionId: "ses-doc-curator",
  })

  return project
}
