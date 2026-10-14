# FilmCraft · OTools 插件

把 [storytold/filmcraft](https://github.com/storytold/filmcraft)（开源、纯 Rust 重写的 Premiere Pro 替代品）
移植为 OTools 插件：上游的 UI 原封不动编译到 WebAssembly，外壳把「文件从哪来、存到哪去」
换成 OTools 宿主的对话框与磁盘读写。

- 插件目录：`plugins/otools-filmcraft`（在 [ootools/OTools](https://github.com/ootools/OTools) 主仓里）
- 上游源码：**不入库**，见 `upstream.pin` + `scripts/fetch-upstream.mjs`

## 构建

```bash
unset RUSTC_WRAPPER                 # 它会把 cargo 指向旧 rustc
node scripts/fetch-upstream.mjs     # 拉取 pinned 的上游到 upstream/
node scripts/build-wasm.mjs         # trunk build --release → dist/
```

需要 rustc >= 1.95 与 wasm32-unknown-unknown 目标（egui 0.36 的要求）。

详细约定见 [AGENTS.md](./AGENTS.md)。
