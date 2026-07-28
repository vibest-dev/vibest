# Effect 平台服务迁移:node 原生 API → effect/FileSystem · Path · Crypto

2026-07-27 定案(grilling 会话)。方针:**除了不能用 Effect 的地方,都要用**——
副作用一律走 Effect 平台服务;豁免仅限 Effect 确实无法建模的边界,"不想动"不构成
豁免理由。本次一个分支全量迁移,不分波次。

## 豁免清单(写死,后续 agent 不得"顺手修正")

| 位置                                                                                  | 理由                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/daemon/launcher.ts` 的 `spawnDetached`                           | detached + unref + stdio 重定向到 log fd,与 `ChildProcessSpawner` 的受监督语义(piped stdio、scope 关闭即杀)正好相反;文件注释已声明这是 Effect 无法建模的一道缝 |
| `packages/server/src/http/server.ts` 整体                                             | node:http + ws 库 + oRPC WS handler + Vite HMR 四方共享同一 server 与 upgrade 事件;`NodeHttpServer` 替换会破坏 oRPC/Vite 集成,收益为负                         |
| 豁免区内的调用点                                                                      | 例:`http/auth.ts` 的 `randomUUID`(ticket)被 Promise 风格的 `http/server.ts` 同步调用,调用上下文非 Effect,保留 node:crypto                                      |
| `apps/desktop/src/main` 的 Electron API 交织处                                        | `app-protocol` / `main-window` / `desktop-config` / `lib/utils` 与 Electron 生命周期绑定                                                                       |
| `packages/services` 的 terminal-manager                                               | node-pty 无 Effect 等价物(且该包 dormant)                                                                                                                      |
| `node:os.homedir`(`config/paths.ts`、`rpc/fs.ts`)                                     | Effect 无 OS/home 目录服务                                                                                                                                     |
| `node:module.createRequire`(`harness/claude-code/executable.ts` 中解析 SDK 的段落)    | 无 Effect 等价物                                                                                                                                               |
| `daemon/port.ts`(node:net 试绑端口)、`process.kill` 信号(`liveness.ts`/`launcher.ts`) | Effect 无端口探测 / 进程信号的平台服务                                                                                                                         |

## 迁移清单(全部"能用"项)

1. **`infra/json-store.ts`** → `effect/FileSystem` + `effect/Path`。
   - 依赖形态:**R 通道冒出**,签名变
     `Effect<A, StoreReadError, FileSystem.FileSystem | Path.Path>`;不在模块内封死
     layer,不升格为 service。
   - 错误仍收敛为 `StoreReadError` / `StoreWriteError`;ENOENT 判断改用
     PlatformError 的 `NotFound` reason(替代 errno 字符串)。
   - `writeJsonAtomic` 的 tmp 文件名 `randomUUID` → `effect/Crypto`。
   - `readJsonDir` 的顺序 for 循环顺带改 `Effect.forEach`。
2. **`session/repository.ts`** — 两处裸 `readdir` → `fs.readDirectory`;
   `withFileTypes` 目录过滤改用 stat(或逐目录 readDirectory 容错)。
3. **project / provider / mcp repository** — R 通道连锁更新:Layer 的 R 从 `Paths`
   变 `Paths | FileSystem | Path | Crypto`,在 `rpc/runtime.ts` 统一 provide
   (NodeFileSystem / NodePath 已在,补 Crypto 的 node layer)。
4. **node:crypto 全量**(豁免区外)→ `effect/Crypto`:launcher 的
   `randomBytes(32)` token、`project/service` 与 `session/service` 的实体 id。
5. **`harness/executable.ts` + `harness/claude-code/executable.ts`** →
   Effect 化,`accessSync(X_OK)` → `fs.access`;deps 注入改为 FileSystem 注入;
   createRequire 段保留(豁免)。
6. **daemon `lock.ts` / `record.ts` / `tombstone.ts`** → FileSystem。
   锁的排他创建用 `fs.open(path, { flag: "wx" })`(`OpenFlag` 已含 `"wx"`)。
   同步变异步会移动锁竞态窗口——迁移时重新推演 launcher 的加锁/重入序列。
7. **`daemon/launcher.ts`** — 编排已是 Effect,内部裸同步调用改 `yield*`;
   `mkdirSync` → `fs.makeDirectory`;R 冒出 `FileSystem | Path | Crypto`。
   调用方(CLI `cli.ts` 走 NodeServices、desktop `daemon-server-process.ts` 走
   desktop-runtime)按需补 layer,均为机械改动。
8. **`http/ui.ts`** — 静态资源读取 → FileSystem;Vite dev server 段不动。
9. **`config/paths.ts`** — `join` → Path 服务,`Layer.sync` 变 `Layer.effect`;
   `homedir` 保留。
10. **`rpc/fs.ts`** — 残余 node:path → Path;`homedir` 保留。

node:path 原则:**迁移的文件里顺带换 `effect/Path`**;豁免区文件保留 node:path。

## 测试策略

- 现有真实 fs + `mkdtemp` 测试全保留,断言不动;各 `makeLayer` 机械补
  `NodeFileSystem.layer` / `NodePath.layer`(及 Crypto layer)。
- **新增故障注入测试**:自制 fake FileSystem layer(`FileSystem.make`),验证
  读失败 → `StoreReadError`、写失败 → `StoreWriteError`、NotFound → fallback
  路径的错误映射层。
- `apps/desktop/.../daemon-server-process.test.ts` 直接调用同步 `readRecord`,
  随 record.ts Effect 化一并更新。

## 规则成文

`.agents/rules/stack.md` 新增一节,与迁移同 PR 提交:新写副作用代码
(fs / 子进程)走 `effect/FileSystem`、`Path`、`Crypto`、`ChildProcessSpawner`,
layer 在 composition root 统一 provide;附上方豁免清单及理由。

## 实施顺序(同分支内分 commit)

json-store + 四个 repository → crypto 全量 → executable ×2 → daemon 三件套 +
launcher → ui / paths / rpc-fs → stack.md 规则。

## 实现时需现场验证

- `NodeFileSystem` 对 `open` `"wx"` flag 的实际行为(锁语义等价性)。
- `effect/Crypto` 的 node layer 名称,以及 CLI 所用 `NodeServices.layer`
  是否已包含 FileSystem/Path/Crypto,缺则单独补。
- `readDirectory` 无 `withFileTypes` 时目录判定的实现取舍。
