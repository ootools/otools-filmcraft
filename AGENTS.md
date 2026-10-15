# AGENTS.md —— otools-filmcraft 移植约定

给后续接手这个仓库的 agent（和人）的规则。核心一句话：**`upstream/` 一行都不要改**，
所有移植代码都放在 `shell/`，这样上游同步永远干净。

## 铁律

1. **`upstream/` 保持上游原样**。它是 `storytold/filmcraft` 在 `upstream.pin`
   里那个 commit 的浅拉取结果，**不在 git 里**（见 `scripts/fetch-upstream.mjs`）。
   任何「顺手改一下上游」的念头都会在下次同步时丢失或变成冲突。
2. `shell/src/` 里凡是标明「上游副本」的文件，不要就地改；要改行为就改
   `shell/src/otools.rs` 或 `shell/src/main.rs`。
3. **不引入 native cdylib**。OTools 宿主已经注入了
   `tools_webview_read_file` / `tools_webview_write_file` 与文件对话框，够用；
   再加 FFI 只是多一份动态库要跟着分发。
4. **改 `shell/Cargo.toml` 的上游依赖版本时，对齐 `upstream/Cargo.toml` 的
   `[workspace.dependencies]`**（egui/eframe 目前是 `0.36` 这一档）。

## 上手前必须知道的三件事

- **rustc 版本**：上游 `rust-version = "1.95"`（egui 0.36 用了 1.95 才稳定的
  `Vec::push_mut`）。本机 1.94 会在 `epaint` 上直接 `E0658`。
  `scripts/build-wasm.mjs` 会检查并提示。本机环境变量 `RUSTC_WRAPPER=sccache`
  指向 PATH 里的旧 rustc，会让 cargo 用错工具链——构建前 `unset RUSTC_WRAPPER`。
- **git 拉取优先走 SSH**：HTTPS 直连 github.com 在本机会偶发超时（21s 连接失败），
  `fetch-upstream.mjs` 的策略是「SSH 优先，回落 HTTPS」。
- **trunk 首次运行会下载 wasm-bindgen-cli 与 wasm-opt**（GitHub release），
  国内网络可能要直连；CI 里已配 `CARGO_NET_GIT_FETCH_WITH_CLI`。

## 上游管理：pin + 按需拉取（不是 subtree / submodule）

上游源码**不在**本仓库里，只有 `upstream.pin` 记录了仓库与精确的 40 位 commit：

```json
{ "upstream": "storytold/filmcraft", "ssh": "…", "https": "…", "ref": "main", "commit": "…" }
```

- **本地/CI 取源码**：`node scripts/fetch-upstream.mjs`（缺失才拉，已对齐就跳过；
  `--force` 丢弃本地改动重拉）。GitHub 允许按任意可达 commit 做 `--depth 1` 拉取。
- **同步上游更新**：改 `upstream.pin` 的 `commit` 为新的完整 SHA，重新拉取，
  然后 diff `upstream/apps/filmcraft-web/src/*.rs` 与 `shell/src/*.rs`。
- **为什么不用 subtree**：单个快照 16~38 MB、五个合计约 150 MB，且每次同步只增不减，
  还会把上游几千个文件混进自己的树（干扰 grep / IDE 搜索）。pin 到 SHA 反而更可复现。

## 移植层的地图

| 文件 | 作用 |
| --- | --- |
| `shell/index.html` | 唯一的 JS：`window.filmcraftOtools`（available/theme/openFiles/saveFile） |
| `shell/src/otools.rs` | 桥：`pick_open` / `pick_save` / `deliver` / 主题 |
| `shell/src/main.rs` | 外壳：eframe 起应用、`?cpu/?webgl` 等 URL 开关 |
| `upstream/` | （不在 git 里）上游源码，都是 path 依赖直接复用 |

## 常见任务

- **构建 dist/** → `node scripts/build-wasm.mjs`（会先自动 take upstream）。
- **本地试跑** → `scripts/deploy-to-otools.ps1` 同步到 otools 仓库的 `plugins/otools-filmcraft`。
- **改 OTools 侧的元信息**（名称/图标/关键词）→ `plugin.json`。

## 不要做的事

- 不要把 `upstream/` 提交进 git（它是构建中间件，不是源码）。
- 不要给 `upstream/` 里的 crate 打 patch、加 `cfg`、写 TODO。
- 不要在本仓库跑 `cargo build` 而不管 target：外壳是 wasm-only 的，
  宿主（x86_64）下 `main()` 只会打印一行提示，别把它当编译报错。

## 状态：外壳已移植（2026-10-15），但有几处已知折扣

`shell/` 已能构建出 dist/，无头浏览器实测可启动（约 8s）。做法是**不搬**上游那套
浏览器适配层，自己起应用：

- `shell/src/host.rs`：`Services` 实现。文件读走「宿主真实路径 → 字节」的内存缓存；
  写走宿主的另存对话框；导出沿用上游语义（先在内存编码，再交给 `write_file`）。
- 导入 / 打开工程：弹宿主的打开对话框，读完字节后由 `post` 排到下一帧执行
  `file.import` / `file.open`。
- 每帧额外 `session.pump_jobs(30ms)`：wasm 单线程，导出与转码在帧之间推进。

**未移植**（功能有折扣，但不影响启动与基本剪辑）：

- 音频输出（上游用 AudioWorklet，插件里没有 ⇒ 静音播放）
- 自动保存与崩溃恢复（上游用 OPFS 快照 + 媒体副本）
- WebCodecs 硬解（缺失时上游自己会退回 Rust 软解，可用但慢）
- 控制通道 `window.filmcraft`（MCP / 自动化）

**已优化（2026-10-15）**：`Services::reader()` 已接上基于内存缓存 `Arc<[u8]>` 的
`CacheReader`（随机访问 reader）+ `read_range()` + `file_loader()`。引擎对素材做
定位读取 / 流式解码，不再每次 `read_file` 整段克隆——剪 4K 长素材能省下大量整段
拷贝。缓存也由 `Vec<u8>` 升到 `Arc<[u8]>`，reader 零拷贝共享同一份字节。

**仍未解决（需要宿主配合，是大块工作）**：字节仍整文件驻留内存——导入素材时一次性
base64 解码进缓存，一个几 GB 的 4K 片段还是会吃几 GB。要彻底不占内存，得让宿主按
range 直读磁盘：这需要在宿主侧加一个 range-read 命令，并在 wasm 单线程下用
worker + `Atomics.wait` 把异步 IPC 桥成同步 `Read+Seek`（原生 `FsServices` 的
`FileReader` 就是这么干的，但那是直接 `std::fs`，没有 IPC）。这一步单独排期。
