# CodeMode

vibestd embeds a confined, resumable JavaScript bytecode interpreter (`@vibest/codemode`, powered by
`psychoscript/effect`) over `@vibest/mcp`, letting agents and CLI users execute multi-step JavaScript scripts that chain
tools across MCP servers in a single round-trip without intermediate LLM tokens. Each capability below says what it is
and when it counts as working.

## CM1. Hard-confined `psychoscript/effect` bytecode VM

Scripts execute inside `psychoscript/effect`'s confined bytecode interpreter with zero network (`fetch`), filesystem,
timers, `process`/`env`, or dynamic code evaluation (`eval`/`Function` are rejected). Wall-clock `timeoutMs` (default
30,000 ms) terminates infinite loops (`while (true) {}`) with `ok: false, error.kind: "Timeout"`. `console.log`/`warn`/
`error`/`info`/`debug` output is captured into `logs` and bounded to `maxOutputBytes` (default 32 KiB).

## CM2. Lazy `Host.namespace` tool dispatch and runtime policy guard

Inside the VM, `tools` is exposed as a lazy `Host.namespace` (`tools.<server>.<tool>(args)` or
`tools["server"]["tool"](args)`) returning async host functions (`{ type: "async" }`) so `Promise.all` runs MCP calls
concurrently. MCP servers are never eagerly spawned or queried up front during execution: `vibestd` checks configured
server eligibility (`disabled`, `codemode !== false`, optional `--server` allowlist) and spawns/invokes only the
specific server called at runtime. An optional host `allowTool(path)` policy hook runs before every tool invocation and
fails with `error.kind: "ToolDenied"` on violation (uncatchable by script `try/catch`). Syntax errors fail with
`error.kind: "ParseError"`, and `checkSyntax(code)` exposes `parseProgram(code)` for fast pre-validation.

## CM3. Native Effect v4 fiber supervision and cancellation

Each tool invocation runs as an Effect inside `Host.fn(..., { type: "async" })`, bounded by `maxToolCalls` (default 20)
and `timeoutMs` (default 30,000 ms). Interrupting the outer `execute` Effect immediately interrupts all in-flight MCP
tool Effects.

## CM4. Transactional `store` / `load` state

Scripts read initial state via `load(key)` and stage mutations via `store(key, value)` (deleting with
`store(key, undefined)`). Staged writes are returned in `storeWrites` only when the script succeeds (`ok: true`); any
thrown error, timeout, policy violation, or cancellation rolls back without emitting `storeWrites`.

## CM5. MCP <-> CodeMode bridge, unified `VibestApi` `tools.vibest.*`, HttpApi, and CLI

Enabled MCP servers (`codemode !== false`, not disabled) are exposed lazily as `tools.<server>.<tool>(args)`. Built-in
read-only `vibest` queries are derived directly from `OpenApi.fromApi(VibestApi)` under `tools.vibest.<operation>`
(default allowlist: `project.info`, `project.search`, `session.list`, `session.get`, `session.peek`, `agent.list`,
`harness.list`, `automation.list`, `automation.get`, `mcp.list`, `mcp.skills`, `mcp.read`; configurable via
`codemode.vibest` in `~/.vibest/vibest.json`) and dispatched through the unified `VibestApi` HTTP pipeline with the
caller's headers so parameters, return shapes, and access control stay 100% identical to CLI and HTTP.

Tool results are unwrapped cleanly (returning `structured` content or parsed JSON text when valid JSON) so scripts can
chain `Promise.all` and filter results directly. `vibestd` advertises `capabilities.codemode: true` on `daemon.ping`,
serves `POST /api/codemode/execute` and `GET /api/codemode/declarations`, and the CLI exposes `vibest mcp exec` (with
`--file`, `--input`, `--server`, `--timeout`) and `vibest mcp list [server] --types`.

## CM6. Zero-WASM single binary and durable suspend/resume snapshots

Because `psychoscript/effect` is pure TypeScript/JavaScript with zero native or WebAssembly blobs, `vibest mcp exec`
runs directly out of the compiled single binary with no asset extraction. `@vibest/codemode` re-exports `Runtime`,
`Host`, `parseProgram`, `toBytes`, `fromBytes`, `SnapshotError`, and `SuspendError` so workflows can suspend a running
program to bytes (`program.suspend()` -> `toBytes(state)`) and resume it later (`runtime.resume(fromBytes(bytes)).run()`).
