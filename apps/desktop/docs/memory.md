# 内存与性能：问题、方案和结果

Apple M4 Pro，go1.27.2，MyGo v0.5.1，herdr 0.9.5。前半是 2026-10-19 用无头基准做的分析，
后半是 2026-10-21 用真窗口加 herdr 测的结果。

## 怎么测

| 工具                                                               | 测什么                                            | 命令                                        |
| ------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------- |
| Go 基准（`mem_bench_test.go`、`internal/herdr/mem_bench_test.go`） | 解码、clone、画一帧的分配                         | `go test -run x -bench . -benchmem ./...`   |
| 缓存报告                                                           | 各缓存常驻多大                                    | `go test -run TestReport -v ./internal/app` |
| `scripts/perf.sh`                                                  | 真机：app 和 herdr 两边的内存、CPU，含 Metal 纹理 | `sh scripts/perf.sh [APP_BINARY]`           |

无头基准走 MyGo 的软件光栅器，画布在 Go 堆里（`raster.NewImage`，约 3.6 MB/帧）；真机上这部分是
Metal 纹理，不进 Go 堆，所以纹理相关的问题只有 `perf.sh` 看得到。

`perf.sh` 自己起一个 herdr server（session `mygo-perf`，`/bin/sh`，关声音），再开真窗口连上去，
依次跑：空闲；3 个 pane、其中一个持续输出 10 秒；agent TUI（备用屏 + 每 30 ms 同步整屏重画）10 秒；
3 个 pane 同时跑（一个 TUI、两个持续输出）10 秒；4 个 tab × 3 个 pane 来回切 40 次；再空闲 15 秒。窗口会出现在屏幕上，保持 1280×800。
结束或 Ctrl-C 都会停掉并删除这个 session。改性能相关的代码前后各跑一次比较。

## 数据从哪来、存在哪

```
herdr socket ─readFrame(新 []byte)─▶ dec.surface/patch ─▶ Shell.surface（patch 的基底，原地改）
                                                           │ publish：每条消息 clone 整帧
                                                           ▼
                                                     App.surface ─▶ grid.paint（主线程）
                                                                     ├ tileKey：每帧哈希每个 tile 的全部格子
                                                                     ├ rowsCache：只留上一帧用到的行
                                                                     ├ shaped：按 run 文本缓存字形
                                                                     └ tiles：每个 pane 一张画布（GPU 纹理）
```

常驻两份完整的帧（`Shell.surface` + `App.surface`）。publish 要 clone，是因为读消息的 goroutine
在原地改自己那份，主线程不加锁画另一份。

## 问题

| #   | 位置                                          | 现象                                                                                        | 量级                                             |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | `internal/herdr/shell.go` `publish` → `clone` | 每条 surface/patch 消息复制整帧，哪怕只改了一行                                             | 240×60：每条 467 KB；真机持续输出约 14 MB/s 垃圾 |
| 2   | `grid.go` `shaped`                            | 只在条目数超过 8192 时清空，不管字形数                                                      | 合成的滚动输出常驻 7.2 MB 字形，理论最坏约 78 MB |
| 3   | `grid.go` `rowKey`                            | 每行拼一个字符串当 map key                                                                  | 208 列每行 4.7 KB、12 次分配                     |
| 4   | `herdr.Cell`                                  | `Link int` 让每格 40 B                                                                      | 每份帧多 20%                                     |
| 5   | `grid.tile` 画布                              | 尺寸变了或 pane 换了就新建画布；旧纹理要等 GC 回收画布、再等渲染器每 120 帧一次的清扫才释放 | 切 40 次 tab 后纹理 600 MB                       |
| 6   | 光标闪烁                                      | 光标画在 pane 纹理里，每次闪烁重画整个 pane                                                 | 每 0.5 秒一次整 pane 重画                        |
| 7   | `readFrame`                                   | 每条消息新分配缓冲                                                                          | 每条整帧 100–400 KB                              |
| 8   | `dec.cell`                                    | 每个非 ASCII 符号分配一个小字符串                                                           | 240×60 帧 723 次分配                             |
| 9   | 窗口在画时的纹理                              | 一个 pane 也停在约 144 MB                                                                   | MyGo 内部                                        |

确认不是问题的地方：`rowsCache` 每帧替换，有界；`tileKey` 复用 `keyBuf`，0 分配；空闲帧 704 B；
嵌入字体 3.4 MB 只在缺字体时注册一次；view.go 每帧几 KB 的小字符串可以忽略；herdr 一侧约 10–13 MB、
CPU 约 1%，不是瓶颈。

## 方案和结果

### 已做

| 问题 | 改动                                                                    | 结果                                                                                                                       |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 3    | `rowKey` 改 64 位 FNV 哈希，复用 `keyBuf`，`rowsCache` 改 `map[uint64]` | 每行 12 次分配 → 0；一行变化的帧 772 → 95 次分配                                                                           |
| 2    | `shaped` 只在重画 tile 时换成这一帧用到的 run                           | 滚出屏幕的行不再留在缓存里（`TestShapedDropsOffScreen`、`TestBlinkKeepsCaches`）                                           |
| 4    | `Cell.Link` 改 `int32`                                                  | Cell 40 → 32 B；clone 581 → 467 KB                                                                                         |
| 6    | 光标画在窗口上，不进 pane 纹理                                          | 闪烁不再重画 pane（`TestCursorBlinkKeepsTheTile`）                                                                         |
| 5    | 画布宽高向上取整到 64 px                                                | 拖分割线时一列的移动不换纹理（`TestTileCanvasStaysForACell`）；正好压在 64 px 边界上来回拖仍会重建                         |
| —    | 接受 herdr 的 scroll、delta 编码                                        | 传输量：切 tab 1.5 MB → 14 KB，agent TUI 266 → 153 KB；本机 app 的 CPU 和内存测不出差别，收益在连保存的机器时的 ssh 链路上 |
| 5    | 消失的 pane 的画布交给同尺寸的新 pane                                   | 切 40 次 tab 后纹理 601 → 143 MB，总内存 695 → 232 MB（`TestTabSwitchReusesCanvases`）                                     |

### 试过、没留

| 方案                         | 结果                  | 为什么不留         |
| ---------------------------- | --------------------- | ------------------ |
| 升级 MyGo 到 v0.5.5          | 问题 9 的 144 MB 不变 | 没有收益           |
| 切 tab 后主动 `runtime.GC()` | 测不出差别            | 有画布复用后不需要 |

### 不做（测过，不值得）

- 每帧最多 clone 一次、复用 clone 缓冲（问题 1）：真机上堆稳定在 25–28 MB，持续输出时 app CPU 约 6%，
  省下的只是 GC 的少量工作，却要处理主线程和读 goroutine 之间的缓冲归还。
- `readFrame` 复用缓冲、解码时驻留常见符号（问题 7、8）：同上，堆和 CPU 都没有压力。
- 问题 9：MyGo 内部行为，空闲 2 秒后的 trim 会降到几 MB。要动只能改 MyGo。
- 紧凑 Cell（`Symbol` 改 `rune`）、按行写时复制：改动面大，以上数字说明没必要。
- 给 `gridRow` 上 `sync.Pool`、字体懒加载：前者行本来就缓存着，后者字体由 CoreText 持有。

## 基线

`scripts/perf.sh`，2026-10-21，1280×800 Retina 窗口：

| 场景               | app 总量 / 纹理 | app CPU | herdr 内存 / CPU |
| ------------------ | --------------- | ------- | ---------------- |
| 空闲               | 104 / 17 MB     | —       | 10 MB            |
| 一个 pane 持续输出 | 231 / 143 MB    | 6%      | 11 MB / 1%       |
| agent TUI 整屏重画 | 229 / 143 MB    | 6%      | 11 MB / 1%       |
| 3 个 pane 同时输出 | 235 / 146 MB    | 13–14%  | 14 MB / 3%       |
| 切 40 次 tab 后    | 232 / 143 MB    | —       | 13 MB            |
| 之后空闲 15 秒     | 55 / 4 MB       | —       | 13 MB            |

没有画布复用时，切 40 次 tab 后是 695 / 601 MB，其他场景相同。两次运行之间总量差 20–40 MB、
CPU 差 1–2 个百分点（空闲那一项取决于窗口是否已经 trim），比较时看纹理和量级，不看个位数。
