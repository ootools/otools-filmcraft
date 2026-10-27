# FilmCraft · OTools 插件

把 [storytold/filmcraft](https://github.com/storytold/filmcraft)（开源、纯 Rust 重写的 Premiere Pro 替代品）
移植为 OTools 插件：上游的 UI 原封不动编译到 WebAssembly，外壳把「文件从哪来、存到哪去」
换成 OTools 宿主的对话框与磁盘读写。

- 插件目录：`plugins/otools-filmcraft`（在 [ootools/OTools](https://github.com/ootools/OTools) 主仓里）
- 上游源码：**不入库**，见 `upstream.pin` + `scripts/fetch-upstream.mjs`

## MCP

插件通过宿主的 **headless MCP 后端**暴露上游 `filmcraft-automation` 的 17 个工具
（`command_list` / `command_run` / `render_preview` / `ui_*` …），不另写一套工具定义。

与 designcraft / pdfcraft 的差别：上游的工具表由 `rmcp` 的 `#[tool_router]` 宏生成，
**没有独立导出**。因此 `native/` 不复制工具定义，而是在 dylib 内起一个**常驻**的上游
MCP 服务，经 `tokio::io::duplex` 内存管道与它对话：

```
宿主 FFI ── tools/list ──▶ 内存管道 ──▶ filmcraft_automation::FilmcraftMcp::serve_io
         ── tools/call ──▶   （按 JSON-RPC id 与等待位配对）
```

- `plugin.json` 声明 `mcp.backend = "headless"` + `native.enabled = true`；
- **`annotations` 不写**：上游 rmcp 已经把 `readOnlyHint` / `destructiveHint` 编译进
  工具表，manifest 写注解会覆盖上游的权威语义；
- 工具表、schema 严格校验、长导出任务的进度上报、`filmcraft://` 资源都跟着上游走，零漂移；
- 会话常驻，`command_run file.open → doc_inspect → render_preview` 落在同一个 `Session` 上；
- 单次调用超时 600s（导出/渲染），取工具表 60s。

### resources

上游除了 tools 还提供 **MCP resources**，插件原样转发，不复制内容：

| URI | 内容 |
| --- | --- |
| `filmcraft://document` | 工程树 + 当前序列（等同 `doc_inspect`） |
| `filmcraft://commands` | 全部命令的 id / label / 菜单路径 / 快捷键 / 参数 / 启用状态（等同 `command_list`） |

对应宿主 ABI 的三个 method（与 `__otools_mcp_tools__` 同族，宿主冻结）：

| method | payload | 返回 |
| --- | --- | --- |
| `__otools_mcp_resources__` | `{}` | `{resources: [...]}` |
| `__otools_mcp_resource_templates__` | `{}` | `{resourceTemplates: [...]}` |
| `__otools_mcp_read_resource__` | `{uri}` | `{contents: [{uri, mimeType, text\|blob}]}` |

`resources/read` 的错误以 `ok:false` 表达（resources 没有 `isError` 信封）。上游说
「没这个 uri」时宿主会转成 MCP 的 `resource not found`。

**宿主侧同样补齐了 resources**（`crates/ot-mcp-gateway` 的 `McpBackend` +
`src-tauri/src/platform/mcp/server.rs` 的 `GatewayHandler`）：有资源才在 `initialize`
里声明 `resources` 能力，`read` 前先按 URI 反查归属插件——未声明的 URI 不会被打到插件上。

数据流见 `native/src/service.rs`。`plugin_manifest_expose_matches_upstream_tools`
测试断言 `plugin.json` 的 `mcp.expose` 与上游工具表一致。

本地冒烟（按宿主的方式 dlopen 并真调工具 + 列举/读取资源）：

```bash
cargo build --release --manifest-path native/Cargo.toml
node scripts/smoke-mcp.mjs ..          # 参数是各 craft 仓库的共同父目录
```

冒烟检查五件事：工具面双向一致、manifest 不覆盖上游注解、可选参数真透传、
**每个上游资源都能列举且读回非空内容（未知 uri 必须被拒）**、停机后可重建。

## 上游版本

打包所用的上游提交。`upstream.pin` 是唯一真源，这张表用来回溯「哪个插件版本打的是哪份上游代码」，
每次发布都要在这里加一行。

| 插件版本 | 上游标签 | 上游提交 | 打包日期 |
| --- | --- | --- | --- |
| 0.1.3 | v0.9.0 | `4a69a038d32761f604b3c7e4845b21fb40b3cbe4` | 2026-10-21 |
| 0.1.2 | — | `f03e21556d8e3a7155b91892d958debd5255d7af` | — |

## 构建

```bash
unset RUSTC_WRAPPER                 # 它会把 cargo 指向旧 rustc
node scripts/fetch-upstream.mjs     # 拉取 pinned 的上游到 upstream/
node scripts/build-wasm.mjs         # trunk build --release → dist/
```

需要 rustc >= 1.95 与 wasm32-unknown-unknown 目标（egui 0.36 的要求）。

详细约定见 [AGENTS.md](./AGENTS.md)。
