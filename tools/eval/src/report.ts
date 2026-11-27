import type { StoryRunReport, SuiteReport } from "./types.ts"

const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

const fmtNum = (n: number): string => n.toLocaleString("en-US")

const fmtSec = (ms: number): string => `${(ms / 1_000).toFixed(1)}s`

export const renderMarkdownReport = (report: SuiteReport): string => {
  const lines: Array<string> = [
    "# Vibest Real User-Story Evaluation Report (Zero-Hint)",
    "",
    `- **Started**: \`${report.startedAt}\``,
    `- **Finished**: \`${report.finishedAt}\` (\`${fmtSec(report.durationMs)}\`)`,
    `- **Model / Harness**: \`${report.harness}\` (\`${report.provider}/${report.model}\`)`,
    `- **Stories Passed**: **${report.storiesPassed} / ${report.storiesTotal}**`,
    `- **Required Rubric Checks**: **${report.requiredChecksPassed} / ${report.requiredChecksTotal}**`,
    `- **Total Tokens**: **${fmtNum(report.totalTokens)}** (input: \`${fmtNum(report.totalInputTokens)}\`, cacheRead: \`${fmtNum(report.totalCacheReadTokens)}\`, output: \`${fmtNum(report.totalOutputTokens)}\`)`,
    "",
    "## Summary Matrix",
    "",
    "| ID | User Story | Result | Rubric | Turns | Tool Calls | CodeMode | MCP HTTP | Auto CLI | Tokens | Duration |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ]

  for (const s of report.stories) {
    lines.push(
      `| \`${s.id}\` | ${s.title} | ${s.passed ? "PASS" : "FAIL"} | ${s.requiredPassed}/${s.requiredTotal} | ${s.metrics.assistantTurns} | ${s.metrics.toolCallsTotal} | ${s.metrics.httpCodeModeCalls} | ${s.metrics.httpMcpCalls} | ${s.metrics.automationCliCalls} | ${fmtNum(s.metrics.totalTokens)} | ${fmtSec(s.durationMs)} |`,
    )
  }

  for (const s of report.stories) {
    lines.push(
      "",
      `---`,
      "",
      `## ${s.id}: ${s.title} (${s.passed ? "PASS" : "FAIL"})`,
      "",
      `- **Persona / Eval Goal**: ${s.personaGoal}`,
      `- **Session ID**: \`${s.sessionId}\` (\`${s.finalState}\`, \`${fmtSec(s.durationMs)}\`)`,
      `- **Ground Truth**: ${s.groundTruthSummary}`,
      `- **Telemetry**: turns=\`${s.metrics.assistantTurns}\`, bash=\`${s.metrics.bashCalls}\`, mcpSkillRead=\`${String(s.metrics.mcpSkillRead)}\`, codeModeExec=\`${s.metrics.codeModeExecCalls}\`, httpMcp=\`${s.metrics.httpMcpCalls}\`, httpCodeMode=\`${s.metrics.httpCodeModeCalls}\`, httpAuto=\`${s.metrics.httpAutomationCalls}\`, httpErrors=\`${s.metrics.httpErrorCount}\`, spills=\`${s.metrics.spillFiles.length}\``,
      "",
      "### Zero-Hint User Prompt",
      "",
      `> ${s.prompt}`,
      "",
      "### Objective Grader Checks",
      "",
    )

    for (const c of s.checks) {
      lines.push(`- [${c.passed ? "x" : " "}] **${c.id}** (${c.required ? "required" : "telemetry"}) — ${c.label}`)
      lines.push(`  - Evidence: \`${c.evidence.replaceAll("`", "'")}\``)
    }

    lines.push("", "### Turn-by-Turn Execution Trace", "")

    for (const t of s.turns) {
      lines.push(
        `#### Turn ${t.index} (\`${fmtNum(t.totalTokens)}\` tok: in=${fmtNum(t.inputTokens)}, cache=${fmtNum(t.cacheReadTokens)}, out=${fmtNum(t.outputTokens)})`,
      )

      if (t.thinking) {
        lines.push("", "<details><summary>Reasoning</summary>", "", "```text", t.thinking, "```", "</details>")
      }

      for (const tc of t.toolCalls) {
        lines.push("", `**Tool \`${tc.name}\`**:`, "```sh", tc.summary, "```")

        if (tc.resultPreview) {
          lines.push("<details><summary>Output Preview</summary>", "", "```text", tc.resultPreview, "```", "</details>")
        }
      }

      if (t.text) {
        lines.push("", "**Assistant Text**:", "", t.text)
      }

      lines.push("")
    }

    lines.push("### Final Session Reply (`vibest result`)", "", "```markdown", s.replyText || "(empty)", "```")
  }

  return `${lines.join("\n")}\n`
}

const renderStoryPanelHtml = (s: StoryRunReport, idx: number): string => {
  const checksHtml = s.checks
    .map(
      (c) => `
      <div class="check-row ${c.passed ? "ok" : c.required ? "fail" : "neutral"}">
        <span class="badge ${c.passed ? "b-ok" : c.required ? "b-fail" : "b-info"}">${c.passed ? "PASS" : c.required ? "FAIL" : "OBS"}</span>
        <div class="check-body">
          <div class="check-title"><code>${esc(c.id)}</code> ${esc(c.label)}</div>
          <div class="check-ev">${esc(c.evidence)}</div>
        </div>
      </div>`,
    )
    .join("")

  const turnsHtml = s.turns
    .map((t) => {
      const calls = t.toolCalls
        .map(
          (tc) => `
          <div class="tool-box">
            <div class="tool-head"><span class="chip">${esc(tc.name)}</span></div>
            <pre class="code">${esc(tc.summary)}</pre>
            ${tc.resultPreview ? `<details class="out-det"><summary>Tool Result Preview</summary><pre class="out-pre">${esc(tc.resultPreview)}</pre></details>` : ""}
          </div>`,
        )
        .join("")

      return `
        <div class="turn-card">
          <div class="turn-head">
            <strong>Turn #${t.index}</strong>
            <span class="tok-meta">total ${fmtNum(t.totalTokens)} tok (in ${fmtNum(t.inputTokens)} · cache ${fmtNum(t.cacheReadTokens)} · out ${fmtNum(t.outputTokens)})</span>
          </div>
          ${t.thinking ? `<details class="think-det"><summary>Model Thinking</summary><pre class="think-pre">${esc(t.thinking)}</pre></details>` : ""}
          ${calls}
          ${t.text ? `<div class="assistant-msg">${esc(t.text)}</div>` : ""}
        </div>`
    })
    .join("")

  const httpHtml = s.httpLogs
    .map(
      (h) =>
        `<tr><td><code>${esc(h.timestamp.slice(11, 23))}</code></td><td><code>${esc(h.method)}</code></td><td><code>${esc(h.url)}</code></td><td><span class="badge ${h.status < 400 ? "b-ok" : "b-fail"}">${h.status}</span></td><td>${h.spanMs}ms</td></tr>`,
    )
    .join("")

  return `
    <section class="story-panel ${idx === 0 ? "active" : ""}" id="panel-${esc(s.id)}">
      <div class="story-header">
        <div>
          <h2><span class="badge ${s.passed ? "b-ok" : "b-fail"}">${s.passed ? "PASS" : "FAIL"}</span> ${esc(s.id)} · ${esc(s.title)}</h2>
          <p class="goal">${esc(s.personaGoal)}</p>
        </div>
        <div class="story-stats">
          <div><span>Duration</span><strong>${fmtSec(s.durationMs)}</strong></div>
          <div><span>Turns</span><strong>${s.metrics.assistantTurns}</strong></div>
          <div><span>Tokens</span><strong>${fmtNum(s.metrics.totalTokens)}</strong></div>
          <div><span>MCP Skill</span><strong>${s.metrics.mcpSkillRead ? "Read" : "No"}</strong></div>
          <div><span>CodeMode</span><strong>${s.metrics.httpCodeModeCalls} calls</strong></div>
          <div><span>Spills</span><strong>${s.metrics.spillFiles.length}</strong></div>
        </div>
      </div>

      <div class="grid-two">
        <div class="box">
          <h3>Zero-Hint User Prompt (Verbatim Input)</h3>
          <blockquote class="prompt-quote">${esc(s.prompt)}</blockquote>
          <h4>Ground-Truth Oracle</h4>
          <p class="gt-text">${esc(s.groundTruthSummary)}</p>
        </div>
        <div class="box">
          <h3>Objective Grader Rubric (${s.requiredPassed}/${s.requiredTotal} Required)</h3>
          ${checksHtml}
        </div>
      </div>

      <div class="box">
        <h3>Final Assistant Reply (<code>vibest result ${esc(s.sessionId.slice(0, 8))}</code>)</h3>
        <pre class="final-reply">${esc(s.replyText || "(empty)")}</pre>
      </div>

      <div class="box">
        <h3>Turn-by-Turn Reasoning &amp; Tool Call Trace (${s.turns.length} Turns)</h3>
        ${turnsHtml}
      </div>

      <div class="box">
        <h3><code>vibestd</code> HTTP Call Log (${s.httpLogs.length} Requests, ${s.metrics.httpErrorCount} Errors)</h3>
        <table class="tbl">
          <thead><tr><th>Time (UTC)</th><th>Method</th><th>Endpoint</th><th>Status</th><th>Latency</th></tr></thead>
          <tbody>${httpHtml}</tbody>
        </table>
      </div>
    </section>`
}

export const renderHtmlReport = (report: SuiteReport): string => {
  const matrixRows = report.stories
    .map(
      (s) => `
      <tr onclick="selectStory('${esc(s.id)}')" style="cursor:pointer">
        <td><code>${esc(s.id)}</code></td>
        <td><strong>${esc(s.title)}</strong></td>
        <td><span class="badge ${s.passed ? "b-ok" : "b-fail"}">${s.passed ? "PASS" : "FAIL"}</span></td>
        <td>${s.requiredPassed}/${s.requiredTotal}</td>
        <td>${s.metrics.assistantTurns}</td>
        <td>${s.metrics.toolCallsTotal}</td>
        <td>${s.metrics.mcpSkillRead ? "Yes" : "No"}</td>
        <td>${s.metrics.httpCodeModeCalls}</td>
        <td>${s.metrics.httpMcpCalls}</td>
        <td>${s.metrics.httpAutomationCalls}</td>
        <td>${fmtNum(s.metrics.totalTokens)}</td>
        <td>${fmtSec(s.durationMs)}</td>
      </tr>`,
    )
    .join("")

  const tabsHtml = report.stories
    .map(
      (s, i) =>
        `<button class="tab-btn ${i === 0 ? "active" : ""}" id="tab-${esc(s.id)}" onclick="selectStory('${esc(s.id)}')">${s.passed ? "✓" : "✗"} ${esc(s.id)}: ${esc(s.title)}</button>`,
    )
    .join("")

  const panelsHtml = report.stories.map((s, i) => renderStoryPanelHtml(s, i)).join("")

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Vibest Real User-Story Eval Report (${esc(report.model)})</title>
<style>
  :root { --bg:#0b0f17; --card:#131a27; --border:#233047; --text:#e6edf7; --muted:#8fa1bd; --ok:#10b981; --fail:#ef4444; --info:#3b82f6; --code:#090d14; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", sans-serif; background:var(--bg); color:var(--text); line-height:1.55; padding:28px; }
  .wrap { max-width: 1360px; margin: 0 auto; }
  header { display:flex; justify-content:space-between; align-items:flex-end; flex-wrap:wrap; gap:16px; margin-bottom:22px; border-bottom:1px solid var(--border); padding-bottom:18px; }
  h1 { margin:0; font-size:24px; letter-spacing:-0.02em; }
  .sub { color:var(--muted); font-size:14px; margin-top:4px; }
  .kpis { display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:14px; margin-bottom:22px; }
  .kpi { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .kpi .k-label { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; }
  .kpi .k-val { font-size:26px; font-weight:700; margin-top:4px; }
  .box { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:18px; margin-bottom:18px; }
  .box h3 { margin:0 0 12px; font-size:15px; }
  .box h4 { margin:14px 0 6px; font-size:13px; color:var(--muted); }
  .tbl { width:100%; border-collapse:collapse; font-size:13px; }
  .tbl th, .tbl td { padding:9px 10px; border-bottom:1px solid var(--border); text-align:left; }
  .tbl th { color:var(--muted); font-weight:600; font-size:12px; }
  .tbl tr:hover td { background:rgba(59,130,246,0.06); }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; }
  .b-ok { background:rgba(16,185,129,0.18); color:#34d399; border:1px solid rgba(16,185,129,0.35); }
  .b-fail { background:rgba(239,68,68,0.18); color:#f87171; border:1px solid rgba(239,68,68,0.35); }
  .b-info { background:rgba(59,130,246,0.18); color:#60a5fa; border:1px solid rgba(59,130,246,0.35); }
  .tabs { display:flex; gap:8px; flex-wrap:wrap; margin:20px 0 16px; }
  .tab-btn { background:var(--card); color:var(--muted); border:1px solid var(--border); border-radius:8px; padding:9px 14px; font-size:13px; font-weight:600; cursor:pointer; }
  .tab-btn.active { background:#1d2b44; color:#fff; border-color:#3b82f6; }
  .story-panel { display:none; }
  .story-panel.active { display:block; }
  .story-header { display:flex; justify-content:space-between; gap:18px; flex-wrap:wrap; background:var(--card); border:1px solid var(--border); border-radius:10px; padding:18px; margin-bottom:18px; }
  .story-header h2 { margin:0 0 6px; font-size:19px; display:flex; align-items:center; gap:10px; }
  .goal { margin:0; color:var(--muted); font-size:13.5px; max-width:760px; }
  .story-stats { display:grid; grid-template-columns:repeat(3, minmax(95px, 1fr)); gap:10px; }
  .story-stats div { background:var(--code); border:1px solid var(--border); border-radius:8px; padding:8px 10px; }
  .story-stats span { display:block; font-size:11px; color:var(--muted); }
  .story-stats strong { font-size:14px; }
  .grid-two { display:grid; grid-template-columns: 1fr 1fr; gap:18px; }
  @media (max-width: 980px) { .grid-two { grid-template-columns: 1fr; } }
  .prompt-quote { margin:0; padding:12px 14px; background:var(--code); border-left:3px solid #3b82f6; border-radius:6px; font-size:13.5px; white-space:pre-wrap; }
  .gt-text { margin:0; font-size:13px; color:var(--muted); }
  .check-row { display:flex; gap:10px; align-items:flex-start; padding:9px 10px; border-radius:8px; background:var(--code); border:1px solid var(--border); margin-bottom:8px; }
  .check-title { font-size:13px; font-weight:600; }
  .check-ev { font-size:12px; color:var(--muted); margin-top:2px; word-break:break-all; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { margin:6px 0 0; padding:11px 12px; background:var(--code); border:1px solid var(--border); border-radius:7px; overflow-x:auto; font-size:12px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; word-break:break-word; }
  .turn-card { border:1px solid var(--border); border-radius:9px; padding:14px; margin-bottom:12px; background:rgba(9,13,20,0.45); }
  .turn-head { display:flex; justify-content:space-between; font-size:13px; margin-bottom:8px; }
  .tok-meta { color:var(--muted); font-size:12px; }
  .tool-box { margin-top:8px; }
  .chip { display:inline-block; font-size:11px; padding:1px 7px; border-radius:5px; background:#1e293b; color:#93c5fd; font-family:monospace; }
  details { margin-top:6px; font-size:12px; color:var(--muted); }
  summary { cursor:pointer; font-weight:600; }
  .assistant-msg { margin-top:10px; padding:10px 12px; background:#111c2d; border-radius:7px; font-size:13px; white-space:pre-wrap; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Vibest Real User-Story Benchmark Report (Zero-Hint Evaluation)</h1>
      <div class="sub">Harness: <code>${esc(report.harness)}</code> · Model: <code>${esc(report.provider)}/${esc(report.model)}</code> · Zero CLI/MCP/CodeMode hints in user prompts · Real off-the-shelf MCP servers</div>
    </div>
    <div class="sub">${esc(report.startedAt)} → ${esc(report.finishedAt)} (${fmtSec(report.durationMs)})</div>
  </header>

  <div class="kpis">
    <div class="kpi"><div class="k-label">Stories Passed</div><div class="k-val">${report.storiesPassed} / ${report.storiesTotal}</div></div>
    <div class="kpi"><div class="k-label">Required Rubric Score</div><div class="k-val">${report.requiredChecksPassed} / ${report.requiredChecksTotal}</div></div>
    <div class="kpi"><div class="k-label">Total Tokens (All Stories)</div><div class="k-val">${fmtNum(report.totalTokens)}</div></div>
    <div class="kpi"><div class="k-label">Cached Input / Output</div><div class="k-val" style="font-size:18px">${fmtNum(report.totalCacheReadTokens)} / ${fmtNum(report.totalOutputTokens)}</div></div>
    <div class="kpi"><div class="k-label">Wall-Clock Time</div><div class="k-val">${fmtSec(report.durationMs)}</div></div>
  </div>

  <div class="box">
    <h3>Cross-Story Evaluation Matrix (Click Row to Inspect Full Trace)</h3>
    <table class="tbl">
      <thead>
        <tr><th>ID</th><th>User Story</th><th>Verdict</th><th>Rubric</th><th>Turns</th><th>Tool Calls</th><th>Read MCP Skill</th><th>CodeMode HTTP</th><th>MCP HTTP</th><th>Auto HTTP</th><th>Tokens</th><th>Time</th></tr>
      </thead>
      <tbody>${matrixRows}</tbody>
    </table>
  </div>

  <div class="tabs">${tabsHtml}</div>
  ${panelsHtml}
</div>
<script>
function selectStory(id) {
  document.querySelectorAll('.story-panel').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('panel-' + id);
  const tab = document.getElementById('tab-' + id);
  if (panel) panel.classList.add('active');
  if (tab) tab.classList.add('active');
}
</script>
</body>
</html>\n`
}
