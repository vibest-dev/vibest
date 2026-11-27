import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"

import { Automation } from "@vibest/schema/automation"
import { Option, Predicate, Schema } from "effect"

import type { CheckResult, StorySpec } from "./types.ts"

const isJsonObject = Schema.is(Schema.JsonObject)

export const FORBIDDEN_HINT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bvibest\b/i,
  /\bmcp\b/i,
  /\bcodemode\b/i,
  /\bexec\b/i,
  /\btool-output\b/i,
  /skill:\/\//i,
  /\bautomation\b/i,
  /\brun-now\b/i,
  /\bcontext7\b/i,
]

export interface SettlementRecord {
  readonly txId: string
  readonly service: string
  readonly status: "settled" | "failed"
  readonly amountCents: number
}

export interface ServiceSla {
  readonly service: string
  readonly owner: string
  readonly thresholdUsd: number
}

export const SETTLEMENT_SLAS: ReadonlyArray<ServiceSla> = [
  { service: "ledger-core", owner: "@tanghao", thresholdUsd: 500 },
  { service: "fx-quote", owner: "@suqing", thresholdUsd: 600 },
  { service: "card-vault", owner: "@luyang", thresholdUsd: 450 },
  { service: "payout-ach", owner: "@guanyu", thresholdUsd: 800 },
  { service: "tax-engine", owner: "@wenjing", thresholdUsd: 300 },
]

export const SETTLEMENT_REGIONS: ReadonlyArray<string> = [
  "ap-east-1",
  "ap-south-1",
  "ap-northeast-1",
  "eu-central-1",
  "eu-west-1",
  "us-east-1",
  "us-west-2",
  "sa-east-1",
]

export interface RegionalShard {
  readonly region: string
  readonly records: ReadonlyArray<SettlementRecord>
}

export const buildRegionalShards = (): ReadonlyArray<RegionalShard> => {
  const out: Array<RegionalShard> = []

  for (let rIdx = 0; rIdx < SETTLEMENT_REGIONS.length; rIdx++) {
    const region = SETTLEMENT_REGIONS[rIdx]!
    const rows: Array<SettlementRecord> = []

    for (let i = 0; i < 120; i++) {
      const svcIdx = i % SETTLEMENT_SLAS.length
      const service = SETTLEMENT_SLAS[svcIdx]!.service
      const txId = `${region}-tx-${String(i + 1).padStart(3, "0")}`

      if (service === "fx-quote" && i < 20) {
        rows.push({ txId, service, status: "failed", amountCents: 2435 + rIdx * 100 })
      } else if (service === "payout-ach" && i < 15) {
        rows.push({ txId, service, status: "failed", amountCents: 4120 + rIdx * 150 })
      } else if (service === "ledger-core" && i === 0) {
        rows.push({ txId, service, status: "failed", amountCents: 3250 })
      } else if (service === "card-vault" && i === 2) {
        rows.push({ txId, service, status: "failed", amountCents: 2800 })
      } else if (service === "tax-engine" && i === 4) {
        rows.push({ txId, service, status: "failed", amountCents: 1500 })
      } else {
        rows.push({ txId, service, status: "settled", amountCents: 1850 + ((i * 37 + rIdx * 19) % 4000) })
      }
    }

    out.push({ region, records: rows })
  }

  return out
}

export const computeExpectedReconciliation = () => {
  const shards = buildRegionalShards()
  const byService = new Map<string, { total: number; failedCount: number; failedCents: number }>()

  for (const sla of SETTLEMENT_SLAS) {
    byService.set(sla.service, { total: 0, failedCount: 0, failedCents: 0 })
  }

  let totalTransactions = 0

  for (const shard of shards) {
    for (const row of shard.records) {
      totalTransactions += 1
      const agg = byService.get(row.service)!
      agg.total += 1

      if (row.status === "failed") {
        agg.failedCount += 1
        agg.failedCents += row.amountCents
      }
    }
  }

  const breached = SETTLEMENT_SLAS.flatMap((sla) => {
    const agg = byService.get(sla.service)!
    const failedUsd = Number((agg.failedCents / 100).toFixed(2))

    if (failedUsd <= sla.thresholdUsd) return []

    return [
      {
        service: sla.service,
        failedCount: agg.failedCount,
        failedUsd,
        thresholdUsd: sla.thresholdUsd,
        owner: sla.owner,
      },
    ]
  })

  return { totalTransactions, breached }
}

const s1HonoJwtAuth: StorySpec = {
  id: "S1",
  slug: "hono-jwt-auth",
  title: "Hono v4 JWT 路由鉴权改造与单测闭环",
  personaGoal:
    "在不提供任何工具/文档命令提示的前提下，验证开发者要求按最新 Hono v4 官方 API 实现 hono/jwt 鉴权时，Agent 能否完成正确实现并通过全部安全单测，同时观测其是否主动检索外部文档源。",
  promptTemplate:
    "帮我把 src/app.ts 里的 /api/* 路由加上基于 hono/jwt 的 Bearer 鉴权中间件（密钥从 process.env.JWT_SECRET 读取，GET /health 保持免登录公开访问），鉴权通过后在 GET /api/me 返回解码出的 { sub, role }。注意 Hono 新版本对 jwt 中间件的签名算法参数校验很严格，请先核实最新官方文档写法别漏填必填项，改完跑一下 bun test 确保测试全部通过。",
  setup: async (_worldRoot, _extRoot, repoDir) => {
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true })
    await fs.mkdir(path.join(repoDir, "test"), { recursive: true })

    await fs.writeFile(
      path.join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: "checkout-api",
          private: true,
          type: "module",
          scripts: { test: "bun test" },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    )

    await fs.writeFile(
      path.join(repoDir, "src/app.ts"),
      [
        'import { Hono } from "hono"',
        "",
        "export const createApp = () => {",
        "  const app = new Hono()",
        '  app.get("/health", (c) => c.json({ ok: true }))',
        '  app.get("/api/me", (c) => c.json({ sub: "anonymous", role: "guest" }))',
        "  return app",
        "}",
        "",
      ].join("\n"),
      "utf8",
    )

    await fs.writeFile(
      path.join(repoDir, "test/app.test.ts"),
      [
        'import { expect, test } from "bun:test"',
        'import { sign } from "hono/jwt"',
        'import { createApp } from "../src/app.ts"',
        "",
        'process.env.JWT_SECRET = "eval-super-secret-hs256-key"',
        "",
        'test("GET /health stays public", async () => {',
        "  const app = createApp()",
        '  const res = await app.request("/health")',
        "  expect(res.status).toBe(200)",
        "  expect(await res.json()).toEqual({ ok: true })",
        "})",
        "",
        'test("GET /api/me rejects missing or invalid token", async () => {',
        "  const app = createApp()",
        '  const missing = await app.request("/api/me")',
        "  expect(missing.status).toBe(401)",
        '  const wrongKey = await sign({ sub: "usr_9", role: "admin" }, "wrong-secret", "HS256")',
        '  const invalid = await app.request("/api/me", { headers: { Authorization: `Bearer ${wrongKey}` } })',
        "  expect(invalid.status).toBe(401)",
        "})",
        "",
        'test("GET /api/me returns decoded { sub, role } for valid HS256 JWT", async () => {',
        "  const app = createApp()",
        '  const token = await sign({ sub: "usr_42", role: "staff" }, process.env.JWT_SECRET!, "HS256")',
        '  const res = await app.request("/api/me", { headers: { Authorization: `Bearer ${token}` } })',
        "  expect(res.status).toBe(200)",
        '  expect(await res.json()).toEqual({ sub: "usr_42", role: "staff" })',
        "})",
        "",
      ].join("\n"),
      "utf8",
    )

    const { spawnSync } = await import("node:child_process")
    const install = spawnSync("bun", ["add", "hono"], { cwd: repoDir, stdio: "pipe" })

    if (install.status !== 0) {
      throw new Error(`bun add hono failed: ${install.stderr.toString("utf8")}`)
    }

    return {
      prompt: s1HonoJwtAuth.promptTemplate,
      mcpServers: {
        context7: {
          type: "remote",
          url: "https://mcp.context7.com/mcp",
        },
      },
      groundTruthSummary:
        "Hono v4.11+ jwt({ secret, alg: 'HS256' }) requires explicit `alg`; `bun test` verifies /health=200, missing/wrong secret=401, valid HS256 token=200 { sub: 'usr_42', role: 'staff' }.",
    }
  },
  grade: async (ctx) => {
    const testRun = await ctx.runShell(ctx.repoDir, ["bun", "test"])
    const appSrc = await fs.readFile(path.join(ctx.repoDir, "src/app.ts"), "utf8").catch(() => "")
    const usedAlg = /\balg\s*:/.test(appSrc)

    const usedContext7 = ctx.httpLogs.some(
      (h) => h.url.includes("context7") || (h.url === "/api/codemode/execute" && h.status === 200),
    )

    return [
      {
        id: "S1.completed",
        label: "Session completed cleanly",
        passed: ctx.finalState === "completed",
        required: true,
        evidence: `finalState=${ctx.finalState}`,
      },
      {
        id: "S1.tests_pass",
        label: "Project test suite (`bun test`) passes independently in grader",
        passed: testRun.code === 0,
        required: true,
        evidence: `exit=${testRun.code} ${(testRun.stdout + testRun.stderr).trim().slice(0, 240)}`,
      },
      {
        id: "S1.explicit_alg",
        label: "Configured explicit JWT verification algorithm (`alg`) per Hono v4 spec",
        passed: usedAlg,
        required: true,
        evidence: usedAlg ? "Found explicit `alg:` in src/app.ts" : "Missing `alg:` in src/app.ts",
      },
      {
        id: "S1.live_docs_consulted",
        label: "[Telemetry] Proactively queried live Context7 documentation server",
        passed: usedContext7,
        required: false,
        evidence: usedContext7
          ? "Agent autonomously discovered and queried Context7 MCP"
          : "Solved without querying Context7 MCP",
      },
    ]
  },
}

const s2Gateway504Triage: StorySpec = {
  id: "S2",
  slug: "gateway-504-triage",
  title: "线上网关 504 超大日志排障与知识库归档",
  personaGoal:
    "模拟真实线上排障：故障导出快照挂载在外部数据源（含 >100 KiB 大日志，触发 ToolOutput 自动落盘），服务归属与历史事故存在团队知识库中，检验零提示下的自主跨源发现、根因定位与图谱写回。",
  promptTemplate:
    "刚收到线上结账网关一波 504 告警，运维已经把故障现场文件挂在外部排障数据源里了，团队历史故障和模块负责人都在团队知识库里。帮我把根因查清楚：1）大日志里具体报的是哪个上游服务和什么错误码、一共出现了多少条；2）对照上游配置和知识库里该服务的历史问题与负责人，判断这次为什么触发；3）把这次事故（代号 INC-1126）关联到对应服务写回知识库留档，最后给我一份简明排障结论。",
  setup: async (_worldRoot, extRoot, repoDir) => {
    const incidentDir = path.join(extRoot, "incident-2026-1126")
    const memoryFile = path.join(extRoot, "ops-memory.jsonl")
    await fs.mkdir(incidentDir, { recursive: true })

    await fs.writeFile(
      path.join(repoDir, "README.md"),
      "# Checkout Gateway\n\nEdge API gateway routing checkout traffic to payment-svc, inventory-grpc, and promo-engine.\n",
      "utf8",
    )

    await fs.writeFile(
      path.join(incidentDir, "upstream-config.yaml"),
      [
        "upstreams:",
        "  payment-svc:",
        "    protocol: http2",
        "    max_concurrent_streams: 128",
        "    timeout_ms: 3000",
        "  inventory-grpc:",
        "    protocol: http2",
        "    max_concurrent_streams: 16",
        "    timeout_ms: 2500",
        "  promo-engine:",
        "    protocol: http1",
        "    timeout_ms: 1500",
        "",
      ].join("\n"),
      "utf8",
    )

    const errorSlots = new Set([61, 174, 289, 412, 538, 691, 845, 993, 1147])
    const logLines: Array<string> = []

    for (let i = 0; i < 1250; i++) {
      const mm = String(Math.floor(i / 60) % 60).padStart(2, "0")
      const ss = String(i % 60).padStart(2, "0")

      if (errorSlots.has(i)) {
        logLines.push(
          `2026-11-26T20:${mm}:${ss}Z status=504 route=/api/checkout upstream=inventory-grpc err_code=UPSTREAM_RESET_E771 duration_ms=2501 trace_id=tr_${10000 + i}`,
        )
      } else {
        logLines.push(
          `2026-11-26T20:${mm}:${ss}Z status=200 route=/api/checkout upstream=payment-svc err_code=NONE duration_ms=42 trace_id=tr_${10000 + i} pad=0123456789abcdef`,
        )
      }
    }

    await fs.writeFile(path.join(incidentDir, "gateway-access.log"), `${logLines.join("\n")}\n`, "utf8")

    const seedGraphCode = JSON.stringify({
      entities: [
        {
          name: "inventory-grpc",
          entityType: "microservice",
          observations: [
            "owner: @linwei (pager PD-INV-09)",
            "historical_incident: HTTP/2 stream exhaustion & 504 UPSTREAM_RESET_E771 whenever max_concurrent_streams is set below 64",
          ],
        },
        {
          name: "payment-svc",
          entityType: "microservice",
          observations: ["owner: @chenxi (pager PD-PAY-02)", "healthy above 100 concurrent streams"],
        },
      ],
    })

    return {
      prompt: s2Gateway504Triage.promptTemplate,
      mcpServers: {
        incident_files: {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", incidentDir],
        },
        team_kb: {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
          environment: { MEMORY_FILE_PATH: memoryFile },
        },
      },
      seedCommands: [["mcp", "call", "team_kb", "create_entities", seedGraphCode]],
      groundTruthSummary:
        "Upstream `inventory-grpc` failed 9 times with `UPSTREAM_RESET_E771` because `upstream-config.yaml` sets `max_concurrent_streams: 16` (< 64 threshold); owner is `@linwei` (`PD-INV-09`); `INC-1126` must be written back to `team_kb`.",
    }
  },
  grade: async (ctx) => {
    const memoryRaw = await fs.readFile(path.join(ctx.extRoot, "ops-memory.jsonl"), "utf8").catch(() => "")
    const hasServiceAndCode = ctx.replyText.includes("inventory-grpc") && ctx.replyText.includes("UPSTREAM_RESET_E771")
    const hasExactCount = /\b9\b|九/.test(ctx.replyText)

    const hasOwnerAndConfig =
      ctx.replyText.includes("linwei") && /\b16\b/.test(ctx.replyText) && /\b64\b/.test(ctx.replyText)

    const persistedIncident = memoryRaw.includes("INC-1126") && memoryRaw.includes("inventory-grpc")

    return [
      {
        id: "S2.service_and_code",
        label: "Pinpointed `inventory-grpc` and error code `UPSTREAM_RESET_E771`",
        passed: hasServiceAndCode,
        required: true,
        evidence: hasServiceAndCode ? "Reply cites inventory-grpc + UPSTREAM_RESET_E771" : "Missing service or code",
      },
      {
        id: "S2.exact_count",
        label: "Counted exact 9 timeout occurrences across 1,250-line (~108 KiB) log",
        passed: hasExactCount,
        required: true,
        evidence: `spillFiles=${ctx.metrics.spillFiles.length}, replyMentions9=${String(hasExactCount)}`,
      },
      {
        id: "S2.owner_and_config_cause",
        label: "Matched `@linwei` + `max_concurrent_streams: 16 < 64` from config & knowledge base",
        passed: hasOwnerAndConfig,
        required: true,
        evidence: hasOwnerAndConfig ? "Matched @linwei and 16 vs 64 streams" : "Missing owner or stream limit cause",
      },
      {
        id: "S2.kb_writeback",
        label: "Persisted `INC-1126` incident entity/relation in live `@modelcontextprotocol/server-memory` store",
        passed: persistedIncident,
        required: true,
        evidence: persistedIncident
          ? "Verified INC-1126 persisted in ops-memory.jsonl"
          : "INC-1126 not found in ops-memory.jsonl",
      },
      {
        id: "S2.codemode_or_spill",
        label: "[Telemetry] Exercised Vibest MCP / CodeMode / ToolOutput spill pipeline",
        passed: ctx.metrics.httpMcpCalls > 0 || ctx.metrics.httpCodeModeCalls > 0,
        required: false,
        evidence: `httpMcp=${ctx.metrics.httpMcpCalls}, httpCodeMode=${ctx.metrics.httpCodeModeCalls}, spills=${ctx.metrics.spillFiles.length}`,
      },
    ]
  },
}

const startBillingLedgerMcpServer = async (
  shards: ReadonlyArray<RegionalShard>,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> => {
  const byRegion = new Map(shards.map((s) => [s.region, s]))

  const toolsCatalog = [
    {
      name: "list_regions",
      title: "List Settlement Regions",
      description: "Returns all global settlement region identifiers for the monthly billing close.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: { regions: { type: "array", items: { type: "string" } } },
        required: ["regions"],
      },
    },
    {
      name: "get_region_settlements",
      title: "Get Regional Settlement Records",
      description:
        "Returns all settlement transactions (txId, service, status, amountCents) for a single region identifier.",
      inputSchema: {
        type: "object",
        properties: { region: { type: "string", description: "Region ID from list_regions" } },
        required: ["region"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          region: { type: "string" },
          records: {
            type: "array",
            items: {
              type: "object",
              properties: {
                txId: { type: "string" },
                service: { type: "string" },
                status: { type: "string" },
                amountCents: { type: "number" },
              },
              required: ["txId", "service", "status", "amountCents"],
            },
          },
        },
        required: ["region", "records"],
      },
    },
  ]

  const handleRpc = (msg: Schema.JsonObject) => {
    const id = msg.id
    const method = Predicate.isString(msg.method) ? msg.method : ""
    const params = isJsonObject(msg.params) ? msg.params : {}

    if (id === undefined) return undefined

    if (method === "server/discover") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          serverInfo: { name: "billing_ledger", version: "1.0.0", title: "Regional Billing Ledger MCP" },
          instructions: "Query monthly settlement shards by region.",
        },
      }
    }

    if (method === "initialize") {
      const proto = Predicate.isString(params.protocolVersion) ? params.protocolVersion : "2025-03-26"

      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: proto,
          capabilities: { tools: {} },
          serverInfo: { name: "billing_ledger", version: "1.0.0", title: "Regional Billing Ledger MCP" },
          instructions: "Query monthly settlement shards by region.",
        },
      }
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} }
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: { resultType: "complete", tools: toolsCatalog },
      }
    }

    if (method === "tools/call") {
      const toolName = Predicate.isString(params.name) ? params.name : ""
      const args = isJsonObject(params.arguments) ? params.arguments : {}

      if (toolName === "list_regions") {
        const payload = { regions: [...SETTLEMENT_REGIONS] }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            structuredContent: payload,
            content: [{ type: "text", text: JSON.stringify(payload) }],
          },
        }
      }

      if (toolName === "get_region_settlements") {
        const region = Predicate.isString(args.region) ? args.region : ""
        const found = byRegion.get(region)

        if (!found) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Unknown region: ${region}` }],
            },
          }
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            structuredContent: found,
            content: [{ type: "text", text: JSON.stringify(found) }],
          },
        }
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      }
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported method: ${method}` },
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end()

      return
    }

    const chunks: Array<Buffer> = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      try {
        const parsed: Schema.Json = JSON.parse(Buffer.concat(chunks).toString("utf8"))

        if (Array.isArray(parsed)) {
          const replies = parsed.flatMap((item) => {
            if (!isJsonObject(item)) return []
            const out = handleRpc(item)

            return out ? [out] : []
          })

          if (replies.length === 0) {
            res.writeHead(202).end()

            return
          }

          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(replies))

          return
        }

        if (!isJsonObject(parsed)) {
          res.writeHead(400).end("bad jsonrpc payload")

          return
        }

        const single = handleRpc(parsed)

        if (!single) {
          res.writeHead(202).end()

          return
        }

        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(single))
      } catch {
        res.writeHead(400).end("invalid json")
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()

  if (!address || Predicate.isString(address)) {
    server.close()
    throw new Error("Failed to bind billing_ledger HTTP MCP server")
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

const s3RegionalReconciliation: StorySpec = {
  id: "S3",
  slug: "regional-billing-reconciliation",
  title: "8 大区结算账单与知识库红线批量对账",
  personaGoal:
    "评估多数据源聚合效率与数值精确度：外部远程账单服务提供 8 个大区共 960 笔订单明细，知识库有 5 个服务的告警红线与负责人，检验 Agent 是否主动发现数据源并采用批量编程聚合而非逐个刷爆上下文，同时核验美分精度。",
  promptTemplate:
    '帮我做一下月底结算对账：8 个大区的结算明细（amountCents 单位是美分）都在外部账单数据源里，每个服务的失败金额告警红线（thresholdUsd，单位美元）和负责人在团队知识库里。请汇总全部 8 个大区的数据，筛出失败总金额超过告警红线的服务，按服务名升序把结果写到当前项目根目录的 reconciliation-report.json，严格使用以下 JSON 结构：{ "totalTransactions": number, "breachedServices": [{ "service": string, "failedCount": number, "failedUsd": number, "thresholdUsd": number, "owner": string }] }，不要把原始账单刷满对话。',
  setup: async (_worldRoot, extRoot, repoDir) => {
    const memoryFile = path.join(extRoot, "sla-memory.jsonl")
    await fs.writeFile(path.join(repoDir, "README.md"), "# Monthly Settlement Audit Workspace\n", "utf8")

    const shards = buildRegionalShards()
    const billingServer = await startBillingLedgerMcpServer(shards)

    const entitiesPayload = JSON.stringify({
      entities: SETTLEMENT_SLAS.map((s) => ({
        name: s.service,
        entityType: "billing_service",
        observations: [`owner: ${s.owner}`, `thresholdUsd: ${s.thresholdUsd}`],
      })),
    })

    const expected = computeExpectedReconciliation()

    return {
      prompt: s3RegionalReconciliation.promptTemplate,
      mcpServers: {
        billing_ledger: {
          type: "remote",
          url: billingServer.url,
        },
        sla_kb: {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
          environment: { MEMORY_FILE_PATH: memoryFile },
        },
      },
      seedCommands: [["mcp", "call", "sla_kb", "create_entities", entitiesPayload]],
      teardown: billingServer.close,
      groundTruthSummary: `totalTransactions=${expected.totalTransactions}; breachedServices=${JSON.stringify(expected.breached)}`,
    }
  },
  grade: async (ctx) => {
    const expected = computeExpectedReconciliation()
    const reportPath = path.join(ctx.repoDir, "reconciliation-report.json")
    const rawReport = await fs.readFile(reportPath, "utf8").catch(() => "")
    let totalMatches = false
    let breachedMatches = false

    if (rawReport) {
      try {
        const parsed: Schema.Json = JSON.parse(rawReport)

        if (isJsonObject(parsed)) {
          totalMatches = parsed.totalTransactions === expected.totalTransactions

          if (Array.isArray(parsed.breachedServices) && parsed.breachedServices.length === expected.breached.length) {
            const sortedActual = [...parsed.breachedServices].sort((a, b) => {
              const sa = isJsonObject(a) && Predicate.isString(a.service) ? a.service : ""
              const sb = isJsonObject(b) && Predicate.isString(b.service) ? b.service : ""

              return sa.localeCompare(sb)
            })

            const sortedExpected = [...expected.breached].sort((a, b) => a.service.localeCompare(b.service))

            breachedMatches = sortedExpected.every((exp, idx) => {
              const act = sortedActual[idx]

              if (!isJsonObject(act)) return false
              const actUsd = Predicate.isNumber(act.failedUsd) ? Number(act.failedUsd.toFixed(2)) : -1

              return (
                act.service === exp.service &&
                act.failedCount === exp.failedCount &&
                actUsd === exp.failedUsd &&
                act.thresholdUsd === exp.thresholdUsd &&
                Predicate.isString(act.owner) &&
                act.owner.replace(/^@/, "") === exp.owner.replace(/^@/, "")
              )
            })
          }
        }
      } catch {
        void 0
      }
    }

    return [
      {
        id: "S3.report_written",
        label: "Wrote valid JSON `reconciliation-report.json` in workspace",
        passed: rawReport.trim().length > 0,
        required: true,
        evidence: rawReport ? rawReport.trim().slice(0, 260) : "reconciliation-report.json missing",
      },
      {
        id: "S3.exact_total_tx",
        label: `Counted exact totalTransactions = ${expected.totalTransactions} across all 8 regions`,
        passed: totalMatches,
        required: true,
        evidence: `expected=${expected.totalTransactions}`,
      },
      {
        id: "S3.exact_breached_math",
        label: "Cent-exact USD aggregation, SLA threshold filtering, and owner join (`fx-quote` & `payout-ach`)",
        passed: breachedMatches,
        required: true,
        evidence: rawReport ? rawReport.replace(/\s+/g, " ").slice(0, 300) : "no report",
      },
      {
        id: "S3.chose_codemode",
        label: "[Telemetry] Autonomously chose CodeMode (`vibest mcp exec`) to aggregate without context bloat",
        passed: ctx.metrics.httpCodeModeCalls > 0,
        required: false,
        evidence: `codeModeExecCalls=${ctx.metrics.codeModeExecCalls}, httpCodeModeCalls=${ctx.metrics.httpCodeModeCalls}, turns=${ctx.metrics.assistantTurns}`,
      },
    ]
  },
}

const s4SilentProbeMonitor: StorySpec = {
  id: "S4",
  slug: "silent-probe-monitor",
  title: "零打扰后台健康巡检与故障注入唤醒测试",
  personaGoal:
    "检验真实“盯守”用户故事：平时健康时要求静默且不烧模型 Token，异常时才发告警唤醒当前会话；Grader 在模型完成后直接往外部探针数据源注入真实故障验证告警触发。",
  promptTemplate:
    "我接下来要专心重构代码，帮我挂一个每 5 分钟自动跑一次的后台巡检盯一下外部监控探针数据源里的 payment-probe.json（对照同数据源下 thresholds.json 里的 maxP99Ms）：只要 status 是 ok 且 p99Ms 没超标就保持静默，别发消息打扰我也别消耗模型推理 token；一旦 status 不是 ok 或者延迟超标，再给我当前会话发告警消息带上当时的 status 和 p99Ms 数值。建好之后帮我立即手动触发试跑一次确认目前探针正常时它是静默的。",
  setup: async (_worldRoot, extRoot, repoDir) => {
    const probesDir = path.join(extRoot, "staging-probes")
    await fs.mkdir(probesDir, { recursive: true })
    await fs.writeFile(path.join(repoDir, "README.md"), "# Payment Service Refactor\n", "utf8")

    await fs.writeFile(
      path.join(probesDir, "thresholds.json"),
      JSON.stringify({ maxP99Ms: 500 }, null, 2) + "\n",
      "utf8",
    )

    await fs.writeFile(
      path.join(probesDir, "payment-probe.json"),
      JSON.stringify(
        { service: "payment-gateway", status: "ok", p99Ms: 142, checkedAt: "2026-11-26T20:00:00Z" },
        null,
        2,
      ) + "\n",
      "utf8",
    )

    return {
      prompt: s4SilentProbeMonitor.promptTemplate,
      mcpServers: {
        probe_fs: {
          type: "local",
          command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", probesDir],
        },
      },
      groundTruthSummary:
        "Active `every` 5m (`300000ms`) `code` automation (0 LLM tokens); stays silent on `{ status: 'ok', p99Ms: 142 }`; sends alert with `degraded`/`1280` when grader injects fault into `payment-probe.json` and runs `run-now`.",
    }
  },
  grade: async (ctx) => {
    const listRes = await ctx.runVibest(["automation", "list"])

    const preInbox = await ctx.runShell(ctx.worldRoot, [
      "sqlite3",
      path.join(ctx.vibestHome, "vibest.db"),
      `SELECT count(*) FROM inbox WHERE recipient_session_id = '${ctx.sessionId}' AND sender_type != 'user';`,
    ])

    const preNonUserMessages = Number(preInbox.stdout.trim() || "0")

    let autoId = ""
    let isCodeGate = false
    let isFiveMinActive = false
    let healthyRunSilent = false

    try {
      const parsed: Schema.Json = JSON.parse(listRes.stdout)

      if (Array.isArray(parsed) && parsed.length > 0) {
        const row = parsed[0]

        if (isJsonObject(row) && Predicate.isString(row.id)) {
          autoId = row.id
          isCodeGate = isJsonObject(row.action) && row.action.type === "code"

          const isFiveMinTrigger =
            isJsonObject(row.trigger) &&
            ((row.trigger.type === "every" &&
              Predicate.isString(row.trigger.every) &&
              Option.getOrUndefined(Automation.durationMillis(row.trigger.every)) === 300_000) ||
              (row.trigger.type === "cron" &&
                Predicate.isString(row.trigger.cron) &&
                /^\*\/5\s+\*\s+\*\s+\*\s+\*$/.test(row.trigger.cron.trim())))

          isFiveMinActive = row.status === "active" && isFiveMinTrigger
          const runCount = Predicate.isNumber(row.runCount) ? row.runCount : 0
          healthyRunSilent = runCount >= 1 && preNonUserMessages === 0
        }
      }
    } catch {
      void 0
    }

    let faultInjectionTriggeredSend = false
    let faultEvidence = "No automation id to test fault injection"

    if (autoId) {
      const probesDir = path.join(ctx.extRoot, "staging-probes")
      await fs.writeFile(
        path.join(probesDir, "payment-probe.json"),
        JSON.stringify(
          { service: "payment-gateway", status: "degraded", p99Ms: 1280, checkedAt: "2026-11-26T20:10:00Z" },
          null,
          2,
        ) + "\n",
        "utf8",
      )

      const runNow = await ctx.runVibest(["automation", "run-now", autoId])

      const sqliteInbox = await ctx.runShell(ctx.worldRoot, [
        "sqlite3",
        path.join(ctx.vibestHome, "vibest.db"),
        `SELECT content FROM inbox WHERE recipient_session_id = '${ctx.sessionId}' AND sender_type != 'user' ORDER BY id DESC LIMIT 3;`,
      ])

      const inboxOut = sqliteInbox.stdout.trim()
      faultInjectionTriggeredSend =
        runNow.code === 0 && inboxOut.includes("1280") && inboxOut.toLowerCase().includes("degraded")
      faultEvidence = `runNowExit=${runNow.code}; preAlerts=${preNonUserMessages}; inboxAlert=${inboxOut.slice(0, 220)}`
    }

    const checks: Array<CheckResult> = [
      {
        id: "S4.zero_token_code_gate",
        label: "Created 0-token `code` automation (not token-burning `prompt` timer) on 5-minute active schedule",
        passed: Boolean(autoId) && isCodeGate && isFiveMinActive,
        required: true,
        evidence: `id=${autoId || "none"}, isCodeGate=${String(isCodeGate)}, isFiveMinActive=${String(isFiveMinActive)}`,
      },
      {
        id: "S4.silent_when_healthy",
        label: "Trial run while healthy (`status=ok, p99Ms=142`) stayed silent without waking session",
        passed: healthyRunSilent,
        required: true,
        evidence: listRes.stdout.trim().slice(0, 260),
      },
      {
        id: "S4.fault_injection_wakes_session",
        label: "Live Fault Injection (`status=degraded, p99Ms=1280`) triggered alert delivery to session inbox",
        passed: faultInjectionTriggeredSend,
        required: true,
        evidence: faultEvidence,
      },
    ]

    return checks
  },
}

export const ALL_STORIES: ReadonlyArray<StorySpec> = [
  s1HonoJwtAuth,
  s2Gateway504Triage,
  s3RegionalReconciliation,
  s4SilentProbeMonitor,
]
