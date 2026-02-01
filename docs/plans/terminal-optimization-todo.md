# Terminal Optimization TODO

## P2 - 锦上添花

- [ ] **Lazy xterm 初始化** - 只在 terminal 首次可见时创建 xterm 实例
- [ ] **Addon 按需加载** - WebGL/Search/Unicode addon 延迟加载
- [ ] **GPU 加速可配置** - 添加设置项控制 WebGL/Canvas 渲染器

## P3 - 后续考虑

- [ ] **流控 (backpressure)** - VS Code 风格的字符计数 ACK，防止 PTY 淹没 renderer
- [ ] **Search addon** - 终端内搜索功能
- [ ] **进程重启无闪烁** - VS Code SeamlessRelaunchDataFilter 风格，重启时录制数据避免闪烁
- [ ] **DOM detach** - 切换 tab 时 detach DOM 而非隐藏，进一步减少内存

## 参考

- Hyper: https://github.com/vercel/hyper
- VS Code Terminal: https://github.com/microsoft/vscode/tree/main/src/vs/workbench/contrib/terminal
