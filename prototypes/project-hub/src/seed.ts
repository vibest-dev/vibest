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
  <title>Option A — Compact Sidebar Triage</title>
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif; }
    body { margin: 0; background: #0f172a; color: #f8fafc; display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
    aside { background: #1e293b; border-right: 1px solid #334155; padding: 20px 16px; display: flex; flex-direction: column; gap: 14px; }
    .brand { font-weight: 700; font-size: 15px; letter-spacing: -0.01em; color: #38bdf8; display: flex; align-items: center; justify-content: space-between; }
    .pill { background: #ef4444; color: white; border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 700; }
    .nav-item { padding: 9px 12px; border-radius: 8px; font-size: 13px; color: #cbd5e1; background: rgba(255,255,255,0.03); cursor: pointer; display: flex; justify-content: space-between; }
    .nav-item.active { background: #2563eb; color: white; font-weight: 600; }
    main { padding: 28px 32px; display: flex; flex-direction: column; gap: 22px; }
    .header-bar { display: flex; justify-content: space-between; align-items: center; }
    .header-bar h1 { margin: 0; font-size: 20px; }
    .btn-row { display: flex; gap: 10px; }
    button { border: none; border-radius: 8px; padding: 9px 15px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .btn-secondary { background: #334155; color: #e2e8f0; }
    .btn-primary { background: #10b981; color: #052e16; }
    .metrics-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
    .metric-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; }
    .metric-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
    .metric-value { font-size: 26px; font-weight: 700; margin-top: 6px; color: #f1f5f9; }
    .queue-card { background: #1e293b; border: 1px solid #475569; border-radius: 12px; padding: 18px; display: flex; justify-content: space-between; align-items: center; }
    .queue-meta { display: flex; flex-direction: column; gap: 4px; }
    .queue-tag { font-size: 11px; color: #fbbf24; font-weight: 600; }
    .chart-box { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border: 1px dashed #475569; border-radius: 12px; padding: 20px; height: 150px; display: flex; align-items: flex-end; gap: 14px; }
    .bar { flex: 1; background: linear-gradient(180deg, #38bdf8, #2563eb); border-radius: 6px 6px 0 0; position: relative; }
  </style>
</head>
<body>
  <aside id="compact-sidebar">
    <div class="brand">
      <span>vibest mod</span>
      <span class="pill" id="sidebar-needs-badge">3 Needs You</span>
    </div>
    <div class="nav-item active" data-nav="triage"><span>Needs You Queue</span><span>3</span></div>
    <div class="nav-item" data-nav="workstreams"><span>Active Workstreams</span><span>3</span></div>
    <div class="nav-item" data-nav="sessions"><span>Live Harnesses</span><span>4</span></div>
    <div class="nav-item" data-nav="knowledge"><span>Project Memory</span><span>6</span></div>
  </aside>
  <main>
    <div class="header-bar">
      <div>
        <h1>Option A: Compact Sidebar Triage</h1>
        <p style="margin:4px 0 0;color:#94a3b8;font-size:13px;">Single-column queue optimized for rapid keyboard j/k sign-off</p>
      </div>
      <div class="btn-row">
        <button class="btn-secondary" id="batch-defer-btn">Defer Non-Blocking</button>
        <button class="btn-primary" id="approve-merge-btn">Approve &amp; Merge Ready</button>
      </div>
    </div>

    <section class="metrics-grid" id="telemetry-strip">
      <div class="metric-card">
        <div class="metric-label">Running Harnesses</div>
        <div class="metric-value">3 / 3 max</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Pending Reviews</div>
        <div class="metric-value" style="color:#fbbf24;">3 Artifacts</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Median Turn Latency</div>
        <div class="metric-value" style="color:#34d399;">42s</div>
      </div>
    </section>

    <div class="queue-card" id="pr-613-gate-card">
      <div class="queue-meta">
        <span class="queue-tag">VERIFY GATE · PR #613</span>
        <strong style="font-size:15px;">Team CLI Roster &amp; Concurrency Slot Guard</strong>
        <span style="font-size:13px;color:#94a3b8;">All 4 deterministic gates green · Ready for merge into main</span>
      </div>
      <button class="btn-primary" id="card-signoff-btn">Sign Off PR #613</button>
    </div>

    <div class="chart-box" id="throughput-chart">
      <div class="bar" style="height:45%" title="Mon"></div>
      <div class="bar" style="height:68%" title="Tue"></div>
      <div class="bar" style="height:52%" title="Wed"></div>
      <div class="bar" style="height:88%" title="Thu"></div>
      <div class="bar" style="height:95%" title="Fri"></div>
      <div class="bar" style="height:74%" title="Sat"></div>
    </div>
  </main>
  <script>
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
        el.classList.add('active');
      });
    });
  </script>
</body>
</html>`

const DEMO_HTML_VARIANT_B = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Option B — Split Inspector Drawer</title>
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif; }
    body { margin: 0; background: #f8fafc; color: #0f172a; display: grid; grid-template-rows: 56px 1fr; min-height: 100vh; }
    header { background: #ffffff; border-bottom: 1px solid #e2e8f0; padding: 0 24px; display: flex; align-items: center; justify-content: space-between; }
    .tabs { display: flex; gap: 8px; }
    .tab { padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; background: #f1f5f9; color: #475569; cursor: pointer; }
    .tab.active { background: #0f172a; color: #ffffff; }
    .workspace { display: grid; grid-template-columns: 1.2fr 1fr; gap: 20px; padding: 24px; }
    .panel { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 14px; padding: 20px; box-shadow: 0 1px 3px rgba(15,23,42,0.05); }
    .lane-item { padding: 14px; border: 1px solid #e2e8f0; border-radius: 10px; margin-top: 12px; display: flex; justify-content: space-between; align-items: center; }
    .badge-warn { background: #fef3c7; color: #b45309; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    .cta-approve { background: #2563eb; color: white; border: none; padding: 10px 16px; border-radius: 8px; font-weight: 600; cursor: pointer; }
  </style>
</head>
<body>
  <header>
    <strong>Option B: Split Triage Drawer (Light Surface)</strong>
    <div class="tabs">
      <span class="tab active" id="tab-needs-you">Needs You (3)</span>
      <span class="tab" id="tab-active-lanes">In Progress Lanes (3)</span>
    </div>
  </header>
  <div class="workspace">
    <section class="panel" id="left-lane-list">
      <h2 style="margin:0;font-size:16px;">Pending Deliverables</h2>
      <div class="lane-item" id="split-item-spec">
        <div>
          <div style="font-weight:600;">Inbox + Execution Ledger Spec v1</div>
          <div style="font-size:12px;color:#64748b;">2 open decision questions · Author: claude-opus</div>
        </div>
        <span class="badge-warn">Needs Decision</span>
      </div>
      <div class="lane-item" id="split-item-whiteboard">
        <div>
          <div style="font-weight:600;">Service Topology Excalidraw Scene</div>
          <div style="font-size:12px;color:#64748b;">5 architecture nodes · Auto-saved</div>
        </div>
        <span class="badge-warn">Review</span>
      </div>
    </section>
    <aside class="panel" id="right-quick-preview">
      <h2 style="margin:0 0 10px;font-size:16px;">Inline Quick Sign-Off</h2>
      <p style="font-size:13px;color:#475569;line-height:1.5;">
        Previewing <strong>Inbox + Execution Ledger Spec</strong> right beside the queue without leaving the board.
      </p>
      <button class="cta-approve" id="split-drawer-approve-btn">Approve Selected Deliverable</button>
    </aside>
  </div>
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
    summary: "Interactive HTML comparison between Compact Dark Sidebar (Option A) and Light Split Drawer (Option B).",
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
          label: "Option A: Compact Dark Sidebar",
          description: "High-density dark surface with keyboard triage queue and telemetry strip",
          fileName: "variant-a.html",
        },
        {
          id: "option-b",
          label: "Option B: Light Split Drawer",
          description: "Two-column light surface with side-by-side quick sign-off panel",
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
            label: "Option A: Compact Dark Sidebar",
            description: "Matches developer terminal ergonomics and fits wide diagrams.",
            recommended: true,
          },
          {
            id: "option-b",
            label: "Option B: Light Split Drawer",
            description: "Side-by-side preview directly on the board.",
          },
        ],
      },
    ],
  })

  hubDb.addCommentThread({
    artifactId: htmlArtifact.id,
    author: "owner-preview",
    body: "Keep this green primary CTA high-contrast, and show commit SHA tooltip before merge.",
    anchor: {
      kind: "dom",
      variantId: "option-a",
      selector: "#approve-merge-btn",
      tagName: "button",
      textPreview: "Approve & Merge Ready",
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
    title: "PR #613 Merge Sign-Off — Team CLI & Slot Guard",
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
