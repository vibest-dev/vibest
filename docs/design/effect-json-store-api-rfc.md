# RFC: `effect-json-store` 公开 API

- 状态：已采纳（形态定案：`makeJsonDocument` / `makeJsonCollection` 双入口 + 平铺 `migrations` 数组，实现已对齐；曾短暂采用链式 `defineSchema().to()`，经调研 zod-file 后替换；单入口时代曾名 `makeStore`）
- 日期：2026-07-28
- 实现：`packages/effect-json-store`（已按本 RFC 命名落地）

## 1. 背景与动机

调研结论（2026-07-28 深度调研，25 条声明对抗验证）：

- **conf** 是"JSON 文件读写 + schema 校验 + 迁移"一体化的事实标准，但迁移功能被作者本人声明**不提供支持、有已知 bug、无修复计划**；其 semver key 联动宿主 `package.json` version 的设计是主要坑源。
- **verzod / json-up** 证明了"每版本一个 schema + `up()` 转换"的类型化迁移链是正确设计，但二者都不做文件 I/O。
- **electron-conf** 证明了整数版本号 + 构造时逐级执行的迁移引擎足够简单可靠。

本库综合三者：**整数版本链 + 每版本 Effect Schema + up() 转换 + 原子文件读写**，Effect v4 原生。

### 目标

1. `up()` 的入参类型自动从上一版本 schema 推导，零手写标注。
2. 旧版本数据先经其所属版本的 schema 校验，再进入迁移函数（垃圾数据不被"成功迁移"）。
3. 版本号不可能跳号、重号（隐式编号）。
4. 迁移原子性：唯一落盘点是最后的 tmp+rename，中途任何失败磁盘上仍是完整旧文件。
5. 错误全部 tagged，corrupt 文件 fail loud、绝不自动重置。

### 非目标

- 文件 watch（跨进程变更感知）、变更钩子/生命周期 hooks（曾实现 beforeMigration/onChange 后删除——需要通知时在消费方包装层做）、加密（conf 的包袱：密钥在代码里只是混淆）。
- ~~dot-notation~~ 后续已加入（类型安全版 `getKey`/`setKey`，见 §2）。
- 多进程写协调（单进程内用信号量串行化；跨进程是消费方的问题）。

## 2. 核心概念

两个入口，共享同一套信封/校验/迁移/原子写引擎（内部 `codec.ts`），语义借用 Firestore 的 document/collection 词汇：

- **`makeJsonDocument`** — 单例文件（settings.json、projects.json 这类）：`defaults` 必填、构造时急加载、内存缓存、信号量串行化写。
- **`makeJsonCollection`** — 目录里的键控记录（`<dir>/<id>.json`，如 sessions）：不存在是 `Option.none` 而非错误、绝不种子化、无缓存、有 `list`/`remove`。

`schema` 都是当前（最新版）的 Effect Schema，历史版本放在平铺的 `migrations` 数组里。形态借鉴 zod-file（见 §6），关键在于**每个迁移条目和它自己版本的 schema 配对**，使 `migrate` 入参的类型推导是局部的（同一对象字面量内），不需要链式调用也不需要跨数组元素的类型体操。

```ts
import { makeJsonDocument } from "effect-json-store";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, Schema } from "effect";

const SettingsV1 = Schema.Struct({ theme: Schema.String });
const SettingsV2 = Schema.Struct({
  theme: Schema.Literals(["light", "dark"]),
  fontSize: Schema.Number,
});
const SettingsV3 = Schema.Struct({ appearance: SettingsV2 });

const program = Effect.gen(function* () {
  const store = yield* makeJsonDocument({
    path: "/Users/me/.myapp/settings.json",
    schema: SettingsV3, // 当前 schema；document 的值类型 = SettingsV3.Type
    migrations: [
      // 下标 i 的条目就是版本 i+1；当前 schema 是版本 migrations.length + 1
      {
        schema: SettingsV1,
        migrate: (v1) => ({
          // v1 类型自动从同条目的 schema 推出，无需标注
          theme: v1.theme === "dark" ? "dark" : "light",
          fontSize: 14,
        }),
      },
      { schema: SettingsV2, migrate: (v2) => ({ appearance: v2 }) },
    ],
    defaults: { appearance: { theme: "light", fontSize: 14 } },
  });

  const current = yield* store.get; // 读内存缓存，永不失败
  yield* store.set({ appearance: { theme: "dark", fontSize: 16 } });
  const next = yield* store.update((s) => ({
    appearance: { ...s.appearance, fontSize: s.appearance.fontSize + 2 },
  }));
  yield* store.load; // 外部改了文件后重读（含迁移）
});

Effect.runPromise(program.pipe(Effect.provide(NodeFileSystem.layer)));
```

设计要点：

- **版本号仍然隐式**：数组下标 + 1 = 该条目的版本，当前 schema = `migrations.length + 1`。跳号、重号在构造上不可能。首版 store 直接省略 `migrations`。
- **`migrate` 入参编译期自动推导**（mapped tuple + 同条目配对，已在 TS 7 native compiler 上验证）；**`migrate` 返回值在运行时校验**——引擎每执行一步迁移，就用下一版 schema（Type 侧，经 `encodeEffect`）校验输出，失败即 `JsonStoreMigrationError{fromVersion, toVersion}`。这比链式的编译期返回值检查晚，但校验每个中间结果反而更严格，且错误带精确版本号。
- 迁移条目是纯数据对象，可读性对 conf/redux-persist 用户零门槛。

签名：

```ts
/** schema 的最宽约束：decode/encode 不需要任何服务 */
type AnySchema = Schema.Codec<unknown, unknown, never, never>;

/** 一个被取代的版本：它的 schema + 从它迁出的函数（入参由同条目 schema 推导） */
interface MigrationStep<S extends AnySchema> {
  readonly schema: S;
  readonly migrate: (data: S["Type"]) => unknown;
}

interface JsonDocumentOptions<Latest extends AnySchema, Steps extends ReadonlyArray<AnySchema>> {
  /** 绝对路径 */
  readonly path: string;
  /** 当前 schema；document 的值类型 = Latest["Type"] */
  readonly schema: Latest;
  /** 被取代的历史版本，从旧到新；省略表示从未变过形状 */
  readonly migrations?: { readonly [K in keyof Steps]: MigrationStep<Steps[K]> };
  /**
   * 无信封旧文件的收编路径：信封 decode 不过的文件改用此 schema 解码，
   * `migrate` 到 v1 形状后走正常迁移链，写回时带上信封。不配置则报
   * `JsonStoreFormatError`。（document 与 collection 都支持）
   */
  readonly legacy?: MigrationStep<Legacy>;
  /** 文件不存在时的种子值（视为不可变） */
  readonly defaults: Latest["Type"];
}

const makeJsonDocument: <
  Latest extends AnySchema,
  const Steps extends ReadonlyArray<AnySchema> = readonly [],
>(
  options: JsonDocumentOptions<Latest, Steps>,
) => Effect.Effect<JsonDocument<Latest["Type"]>, JsonStoreLoadError, FileSystem.FileSystem>;

interface JsonDocument<A> {
  /** 内存缓存的当前值；makeJsonDocument 时已完成加载/迁移/种子化 */
  readonly get: Effect.Effect<A>;
  /** 整份替换：当前 schema encode（兼作写前校验）→ 原子写 → 更新缓存 */
  readonly set: (value: A) => Effect.Effect<void, JsonStoreEncodeError | JsonStoreWriteError>;
  /** 串行化的 read-modify-write；f 必须纯函数，返回新值 */
  readonly update: (
    f: (current: A) => A,
  ) => Effect.Effect<A, JsonStoreEncodeError | JsonStoreWriteError>;
  /** 类型安全 dot-notation 单键读，如 getKey("appearance.fontSize") */
  readonly getKey: <P extends KeyPath<A>>(path: P) => Effect.Effect<KeyPathValue<A, P>>;
  /** 类型安全 dot-notation 单键写；整值持久化 */
  readonly setKey: <P extends KeyPath<A>>(
    path: P,
    value: KeyPathValue<A, P>,
  ) => Effect.Effect<void, JsonStoreEncodeError | JsonStoreWriteError>;
  /** 重读磁盘（含迁移），刷新缓存 */
  readonly load: Effect.Effect<A, JsonStoreLoadError>;
}
```

dot-notation 的路径类型（`KeyPath<A>` / `KeyPathValue<A, P>`）只穿透**必选的普通对象**：primitive、数组、可选字段都是叶子（可选对象在它自己的 key 上整体读写），因此路径在运行时不可能中途踩到 `undefined`；未知路径和值类型错误都在编译期拒绝。

- `makeJsonDocument` 内部捕获一次 `FileSystem.FileSystem`，document 各方法的 R 通道为 `never`——消费方只在构造时 provide 一次。
- 库**不内置 Context tag**：document 是泛型的，单一库级 tag 无法服务多个不同类型的配置文件。消费方按具体配置包一层（见 §4）。

### 2.1 Collection

对齐 Astro（`defineCollection({loader, schema})` + `getCollection`/`getEntry` → `{id, data}`）与 Fumadocs（`defineCollections({type, dir, schema})`）的 collection 概念，但面向读写而非静态构建：

```ts
const makeJsonCollection: <
  Latest extends AnySchema,
  const Steps extends ReadonlyArray<AnySchema> = readonly [],
>(options: {
  /** collection 目录的绝对路径；条目位于 `<dir>/<id>.json` */
  readonly dir: string;
  readonly schema: Latest;
  /** 与 makeJsonDocument 同一契约 */
  readonly migrations?: { readonly [K in keyof Steps]: MigrationStep<Steps[K]> };
}) => Effect.Effect<JsonCollection<Latest["Type"]>, never, FileSystem.FileSystem>;

interface JsonCollectionEntry<A> {
  readonly id: string;
  readonly data: A;
}

interface JsonCollection<A> {
  /** 缺失是 Option.none（不是错误，绝不种子化）；旧版本条目迁移后写回 */
  readonly get: (id: string) => Effect.Effect<Option.Option<A>, JsonStoreLoadError>;
  /** 新建或整份替换：当前 schema encode → 原子写 */
  readonly put: (
    id: string,
    value: A,
  ) => Effect.Effect<void, JsonStoreEncodeError | JsonStoreWriteError>;
  /** 删除；缺失是 no-op */
  readonly remove: (id: string) => Effect.Effect<void, JsonStoreWriteError>;
  /** 全部条目 id（可 `under` 限定子目录），已排序，不读条目内容；杂散非法文件名被跳过 */
  readonly ids: (options?: {
    readonly under?: string;
  }) => Effect.Effect<ReadonlyArray<string>, JsonStoreReadError>;
  /** 全部条目按 id 排序；目录不存在 = 空表；损坏条目 fail loud（用 `under` 收窄故障域）；有界并发（16） */
  readonly list: (options?: {
    readonly under?: string;
    readonly filter?: (entry: JsonCollectionEntry<A>) => boolean;
  }) => Effect.Effect<ReadonlyArray<JsonCollectionEntry<A>>, JsonStoreLoadError>;
}
```

与 document 的语义分野：

| 维度         | document                       | collection                                                                                   |
| ------------ | ------------------------------ | -------------------------------------------------------------------------------------------- |
| 寻址         | 一个固定文件                   | `<dir>/<id>.json`，id 可含 `/` 嵌套（如 `p1/s1`）                                            |
| 缺失         | `defaults` 种子化写盘          | `Option.none`，绝不创建文件                                                                  |
| 加载时机     | 构造时急加载 + 缓存            | 每次 `get`/`list` 读盘，无缓存                                                               |
| 写序         | Semaphore(1) 串行化            | 同 id 互斥（每 id 一把锁；`get` 的迁移写回不会覆盖并发 `put`/复活 `remove`），不同 id 全并发 |
| 构造失败通道 | `JsonStoreLoadError`（急加载） | `never`（构造纯粹，错误推迟到操作）                                                          |

id 校验：空串、绝对路径、`.`/`..` 段一律 `Effect.die`——**这是"调用方 bug"契约，外部（客户端）可控的 id 必须在进入 collection 前由消费方 sanitize 成 typed error**（见 server SessionRepository 的 `isSafeId`）。磁盘上衍生的名字不受此约束：`ids`/`list` 会跳过非法文件名（如杂散的 `.json`）而不是 die。迁移写回发生在 `get`（含 `list` 内部的 get），与 document 一致走原子写，且受同 id 锁保护。

- 命名取自 Firestore 的 document/collection 对偶；错误类型保留 `JsonStore*` 前缀作为包级伞名。

## 3. 语义

### 3.1 磁盘格式：信封

```json
{
  "version": 2,
  "data": { "theme": "dark", "fontSize": 14 }
}
```

版本号不占用用户字段命名空间（对照：conf 的 `__internal__` 魔法键）；信封 schema 与业务 schema 解耦，先读版本、再选 schema。

### 3.2 行为表

| 场景                        | 行为                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件不存在                  | 用 `defaults` **立即** encode + 原子写盘（目录不可写这类错误在启动时暴露，而非首次 set 时）                                                                                                                 |
| 文件版本 > 代码已知最新     | fail `JsonStoreVersionTooNewError`，**绝不写盘**（防应用回退后静默丢数据）                                                                                                                                  |
| JSON 损坏                   | fail `JsonStoreParseError`，**不自动重置**（对照 configstore 的 `clearInvalidConfig` 直接清空文件）；想"损坏即重置"的消费方自行 catch 后删文件重开                                                          |
| 信封形状不对 / 版本非正整数 | fail `JsonStoreFormatError`；配置了 `legacy` 时按 legacy schema 解码（失败 → `JsonStoreDecodeError{version: 0}`）→ `migrate` 到 v1（失败 → `JsonStoreMigrationError{0,1}`）→ 走正常链并**总是写回信封格式** |
| 文件版本 < 最新             | 旧版 schema decode（失败 → `JsonStoreDecodeError{version}`）→ 内存中逐级 `up()`（抛错 → `JsonStoreMigrationError{fromVersion,toVersion}`）→ latest encode → 原子写回新版本                                  |
| 文件版本 == 最新            | decode 校验后直接用，**不写回**（不碰 mtime）                                                                                                                                                               |
| 迁移原子性                  | 全程内存中，唯一落盘点是最后的 tmp+rename；任何一步失败磁盘仍是完整旧文件，下次启动重新迁移                                                                                                                 |
| 并发 read-modify-write      | per-store `Semaphore(1)` 串行化 `set` / `update` / `load`；`get` 裸读缓存                                                                                                                                   |
| 原子写                      | mkdir -p → 写 `<path>.<uuid>.tmp` → rename                                                                                                                                                                  |

### 3.3 错误类型

全部 `Data.TaggedError`，可 `Effect.catchTag` 精确处理：

```
JsonStoreReadError          读文件失败（非 not-found）
JsonStoreWriteError         mkdir / 写 tmp / rename 失败
JsonStoreParseError         文件存在但不是合法 JSON
JsonStoreFormatError        JSON 合法但信封形状不对
JsonStoreVersionTooNewError 文件版本超前 { fileVersion, latestVersion }
JsonStoreDecodeError        data 不满足其声明版本的 schema { version }
JsonStoreEncodeError        写盘前 latest encode 失败
JsonStoreMigrationError     某步 migrate() 抛出或输出不过下一版 schema { fromVersion, toVersion }

JsonStoreLoadError = 以上全部的联合（makeJsonDocument / load / collection get / list 的错误通道）
```

## 4. 消费方惯例（Effect 应用）

```ts
class SettingsStore extends Context.Service<SettingsStore, JsonDocument<Settings>>()(
  "SettingsStore",
) {}

const SettingsStoreLayer: Layer.Layer<SettingsStore, JsonStoreLoadError> = Layer.effect(
  SettingsStore,
  makeJsonDocument({ path: settingsPath, schema: SettingsV3, migrations, defaults }),
).pipe(Layer.provide(NodeFileSystem.layer));
```

## 5. 面向非 Effect 用户：`/promise` 门面（后续，独立 RFC 不阻塞本篇）

公开发布时增加子路径导出，内部用 `ManagedRuntime` 吞掉 Effect：

```ts
import { makeJsonDocument } from "effect-json-store/promise";

const store = await makeJsonDocument({ path, schema: SettingsV3, migrations, defaults });
store.get(); // 同步读缓存
await store.update((s) => ({ ...s, fontSize: 16 }));
await store.close(); // dispose runtime
```

错误以异常抛出，`_tag` 保留供 `catch` 后判别。迁移条目是纯数据，两个入口共用。

## 6. 已否决的替代方案

| 方案                                       | 否决理由                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 链式 builder `defineSchema(V1).to(V2, up)` | 类型安全等价（且返回值多一层编译期检查），但评审认为链式形态别扭；对照真实世界（redux-persist/zustand/RxDB/Dexie/verzod/zod-file）链式确属少数派，仅 json-up 采用。被平铺数组取代后，返回值检查由逐步运行时校验补偿 | \n  | 独立声明式 `const v2 = version(SettingsV2, v1, up)` | 类型机制与链式相同，但多出无信息量的中间变量名；引入"引用错上一版"这一新错误类别（类型碰巧兼容时静默跳版本），链式每步只能接链尾、构造上无此问题；且链式 builder 不可变、本就可拆成多个常量续写，声明式的灵活性优势不成立 |
| 数组字面量 `versions: [{schema, up}, ...]` | TS 上下文类型化不能跨数组元素：`prev` 需手写标注且标注本身不被校验（标错版本要到运行时才炸）；强行用递归条件类型校验则报错不可读、tsgo 下推断稳定性存疑；数组顺序即版本号，merge 挪位会静默重编号                   |
| conf 式迁移 map `migrations: { 2: fn }`    | `prev: unknown`，类型化迁移链卖点归零；旧数据不经逐版校验直接进迁移函数；显式版本号带回跳号/重号一整类错误                                                                                                          |
| semver 版本键（conf 原版）                 | 联动宿主 package.json version 是 conf 迁移被作者弃保的坑源；调研已确认                                                                                                                                              |
| 库内置 Context tag                         | store 泛型，单一 tag 无法服务多个配置文件；tag 属于应用层                                                                                                                                                           |

## 7. 开放问题

1. **npm 包名与 effect 依赖形态**：`effect-json-store` 直接依赖 effect（Effect 生态惯例），还是 peer dependency？Effect v4 仍在 beta，公开发布前需钉版本策略。
2. **"损坏即重置"是否提供官方糖**：`onCorrupt: "fail" | "reset"` 选项，还是坚持让消费方自己 catch？当前立场：不提供，库不替用户做丢数据的决定。

## 8. 从现有实现迁移

已完成。相对链式版本的改动：

- 删除 `defineSchema` / `VersionedSchema`（`src/schema.ts` 整个移除），`MigrationStep` / `AnySchema` 移入 `store.ts`。
- `JsonDocumentOptions` 变为 `{ path, schema, migrations?, defaults }` 双泛型（`Latest` + mapped tuple `Steps`）。
- 迁移引擎新增逐步运行时校验（`encodeEffect(下一版 schema)`）。
- 测试：`typing.test.ts` 验证入参推导与无迁移形态；`migration.test.ts` 新增"迁移输出不过下一版 schema → MigrationError"用例。

collection 引入后的重构（2026-07-28）：

- `makeStore`/`JsonStore` 更名 `makeJsonDocument`/`JsonDocument`（`src/store.ts` → `src/document.ts`）。
- 信封/校验/迁移/原子写引擎抽入内部 `src/codec.ts`（`makeFileCodec` → `{load, save}`），document 与 collection 共用。
- 新增 `src/collection.ts`（`makeJsonCollection`）与 `test/collection.test.ts`。

server `storage/` 接入（2026-07-28）：

- 新增 `legacy` 选项（见 §2/§3.2）收编无信封存量文件。检测依据是信封 decode 失败——
  session 旧记录体内自带 `version: 1` 但没有 `data` 键，仍会正确走 legacy 路径（有测试钉住）。
- `packages/server/src/session/repository.ts` 改走 `makeJsonCollection`（id = `<projectId>/<sessionId>`，
  `SessionSchema` 与 `Session` 接口的一致性由 `write`/`read` 的双向赋值在编译期兜底）；
  `packages/server/src/project/repository.ts` 改走 `makeJsonDocument`（`Schema.Array(ProjectSchema)`，
  defaults `[]`，构造时急加载 `Effect.orDie`——projects.json 损坏改为启动即失败，而非每次 list 报错）。
- 对外错误面不变：`JsonStore*` 在 repository 层映射回 `StoreReadError`/`StoreWriteError`。
- `infra/json-store.ts` 删掉无消费方的 `readJsonDir`/`removeFile`；`readJson`/`writeJsonAtomic`
  留给 config.json（provider/mcp，本次范围外）。
- 层构造现在含文件 I/O：测试 harness 的 `runtime.runSync(contextEffect)` 改为 `runPromise`
  （生产路径 `createRpcRuntime` 本就是 async，不受影响）。

审查修复（2026-07-29，对抗审查后）：

- collection 增加同 id 互斥锁（`get` 迁移写回不再与并发 `put`/`remove` 竞态）与
  `ids()` / `list({ under })`（session 按项目收窄故障域，`findBySessionId` 只读一个文件体）。
- `listIds` 跳过非法文件名；`JSON.stringify` 包进 `Effect.try`（不可序列化值 → `JsonStoreWriteError`）。
- server：SessionRepository 对客户端可控 id 做 `isSafeId` 消毒（畸形 id → typed not-found 而非 defect）；
  ProjectRepository 改为惰性打开 + 成功后缓存——损坏或超前版本的 projects.json 不再 `orDie` 砖死启动，
  错误按调用以 `StoreReadError` 呈现，文件修好后下次调用自愈。
- 明确暂不做：写回失败使读路径失败（只读文件系统场景）、KeyPath 的 nullable/带点属性名收紧、
  ProjectRepository 改用 `document.update`（lost-update 是旧代码既有行为）。
