# `@vibest/eval` — Real User-Story Evaluation Suite

`@vibest/eval` benchmarks Vibest agent sessions on **authentic, zero-hint developer user stories** against real off-the-shelf MCP servers (`@modelcontextprotocol/server-filesystem`, `@modelcontextprotocol/server-memory`, and remote `https://mcp.context7.com/mcp`), the Psychoscript CodeMode sandbox, `ToolOutput` oversized spills, and 0-token Automations.

## Design Principles

1. **Zero Command Hints**: No user-story prompt may mention `vibest`, `mcp`, `codemode`, `exec`, `tool-output`, `skill://`, `automation`, or `run-now`. Prompts state only the developer's real engineering goal; `test/eval.test.ts` enforces this invariant statically.
2. **Hermetic Isolation**: Every story boots its own temporary `VIBEST_HOME`, `hc` (`herdr-core`) socket, Git repository, external fixture directories, `MEMORY_FILE_PATH`, and a clean `PI_CODING_AGENT_DIR` (preserving only model provider credentials while stripping personal MCP/codemode plugins so 100% of capability discovery comes from Vibest).
3. **Objective Ground-Truth Graders**: Every story is scored by deterministic checks (running unit tests on modified code, verifying exact cent-level financial reconciliation files, inspecting knowledge-graph JSONL persistence, and injecting live faults into background monitors).
4. **Quantitative Telemetry & Visual Traces**: Parses harness `.jsonl` transcripts and `vibestd.log` to report turns, input/cached/output tokens, wall-clock duration, autonomous tool/CodeMode adoption, and renders `eval-report.{json,md,html}`.

## Usage

```sh
pnpm build
pnpm eval                                           # Run all 4 stories on pi (agent=general, tcpa/glm-5.4)
pnpm eval --story S1,S3 --concurrency 2             # Run selected stories in parallel
pnpm eval --agent coordinator --story S2            # Benchmark multi-agent coordinator delegation
pnpm eval --out /path/to/output-dir --timeout 420   # Write JSON/MD/HTML reports to custom directory
```

## Stories

| ID   | Story                                                   | Real MCPs                         | Primary Capability Under Test                                                                             |
| ---- | ------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `S1` | Hono v4 `hono/jwt` Bearer Auth Upgrade                  | `context7` (remote HTTP)          | Autonomous live-doc lookup (`alg: "HS256"` requirement) + passing `bun test`                              |
| `S2` | Production 504 Gateway Triage & Incident Archival       | `filesystem`, `memory`            | External >100 KiB log CodeMode / `ToolOutput` handling + root-cause synthesis + graph writeback           |
| `S3` | 8-Region Settlement & SLA Breach Reconciliation         | `billing_ledger` (HTTP), `sla_kb` | Multi-region remote MCP + graph aggregation via CodeMode without context bloat; cent-exact JSON output    |
| `S4` | Silent Standing Probe Monitor with Live Fault Injection | `probe_fs` (`filesystem`)         | 0-token CodeMode gate (`5m` schedule): stays silent when healthy, delivers alert when live fault injected |
