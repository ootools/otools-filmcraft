//! FilmCraft 的 OTools 插件外壳。
//!
//! 上游 `apps/filmcraft-web` 是 **lib crate**（`wasm_bindgen` 导出 `start(canvas_id)`），
//! 它的浏览器适配层（Blob 虚拟文件表 / OPFS / WebCodecs / AudioWorklet / 恢复日志）
//! 我们不搬，而是自己起 `FilmcraftApp`：
//!
//! 1. `Session::new(Arc::new(HostServices))` —— 文件读写走宿主（见 `src/host.rs`）
//! 2. `HostHooks::pick_files` / `pick_open_project` —— 弹宿主的打开对话框
//! 3. `HostHooks::pick_save` / `pick_save_as` —— 保存/导出交给宿主写盘
//!
//! 未移植的部分（音频输出、自动保存与崩溃恢复、WebCodecs 硬解、控制通道）会让
//! 功能有折扣，但不影响启动与基本剪辑，详见 AGENTS.md 的「状态」一节。
//! 上游 `crates/*` 一律不改：它们按 upstream.pin 的 commit 拉取，保持原样才能干净地跟上上游。

#[cfg(target_arch = "wasm32")]
mod host;
#[cfg(target_arch = "wasm32")]
mod otools;

#[cfg(target_arch = "wasm32")]
mod web {
    use std::sync::Arc;
    use std::time::Duration;

    use filmcraft_engine::Session;
    use filmcraft_ui_egui::FilmcraftApp;
    use wasm_bindgen::JsCast as _;

    const CANVAS_ID: &str = "filmcraft_canvas";
    const LOADING_ID: &str = "filmcraft_loading";

    struct Shell {
        app: FilmcraftApp,
    }

    impl eframe::App for Shell {
        fn raw_input_hook(&mut self, ctx: &egui::Context, raw: &mut egui::RawInput) {
            self.app.raw_input_hook(ctx, raw);
        }

        fn logic(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
            // 异步读文件完成后排的动作在这里执行（上游用 `post` + WebApp 做同一件事）。
            crate::host::pump(&mut self.app);
            self.app.logic(ctx, frame);
            // 导出/转码在帧之间推进（wasm 单线程，没有后台线程）。
            if self.app.session.pump_jobs(Duration::from_millis(30)) {
                ctx.request_repaint();
            }
        }

        fn ui(&mut self, ui: &mut egui::Ui, frame: &mut eframe::Frame) {
            self.app.ui(ui, frame);
        }
    }

    fn query() -> String {
        web_sys::window().and_then(|w| w.location().search().ok()).unwrap_or_default()
    }

    fn has_flag(query: &str, key: &str) -> bool {
        query.trim_start_matches('?').split('&').any(|p| p == key || p.starts_with(&format!("{key}=")))
    }

    pub fn start() {
        eframe::WebLogger::init(log::LevelFilter::Info).ok();
        let query = query();
        wasm_bindgen_futures::spawn_local(async move {
            let Some(document) = web_sys::window().and_then(|w| w.document()) else { return };
            let Some(canvas) = document.get_element_by_id(CANVAS_ID).and_then(|e| e.dyn_into::<web_sys::HtmlCanvasElement>().ok()) else {
                log::error!("missing <canvas id=\"{CANVAS_ID}\">");
                return;
            };
            let mut options = eframe::WebOptions::default();
            if has_flag(&query, "webgl")
                && let eframe::egui_wgpu::WgpuSetup::CreateNew(create) = &mut options.wgpu_options.wgpu_setup
            {
                create.instance_descriptor.backends = eframe::wgpu::Backends::GL;
            }
            let result = eframe::WebRunner::new()
                .start(
                    canvas,
                    options,
                    Box::new(move |cc| {
                        let mut session = Session::new(Arc::new(crate::host::HostServices));
                        // 与上游一致：默认先打开一个示意工程（`?empty` 关掉）。
                        if !has_flag(&query, "empty") {
                            let _ = session.execute("file.openDemoProject", serde_json::json!({}));
                        }
                        let mut app = FilmcraftApp::new(session);
                        // GPU 合成需要浮点渲染目标：只有 WebGPU 支持（WebGL2 走 CPU 合成）。
                        let backend = cc.wgpu_render_state.as_ref().map(|rs| rs.adapter.get_info().backend);
                        if let Some(rs) = cc.wgpu_render_state.clone()
                            && backend == Some(eframe::wgpu::Backend::BrowserWebGpu)
                            && !has_flag(&query, "cpu")
                        {
                            app.set_wgpu(rs);
                        }
                        // 文件对话框：交给宿主（异步：选中后由 `host` 排动作在下一帧执行）。
                        app.hooks.pick_files = Some(Box::new(|exts: &[&str]| {
                            crate::host::pick_files(exts);
                            Vec::new()
                        }));
                        app.hooks.pick_open_project = Some(Box::new(|| {
                            crate::host::pick_project();
                            None
                        }));
                        app.hooks.pick_save = Some(Box::new(|name: &str| {
                            crate::otools::force_pick(false);
                            Some(format!("/projects/{name}"))
                        }));
                        app.hooks.pick_save_as = Some(Box::new(|_filter: &str, _exts: &[&str], name: &str| {
                            crate::otools::force_pick(true);
                            Some(format!("/exports/{name}"))
                        }));
                        Ok(Box::new(Shell { app }))
                    }),
                )
                .await;
            if let Some(el) = document.get_element_by_id(LOADING_ID) {
                match result {
                    Ok(()) => el.remove(),
                    Err(e) => el.set_inner_html(&format!("<p>FilmCraft 启动失败：{e:?}</p><p>需要支持 WebGPU 或 WebGL2 的浏览器。</p>")),
                }
            }
        });
    }
}

#[cfg(target_arch = "wasm32")]
fn main() {
    web::start();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("otools-filmcraft 只在浏览器里运行：在 shell/ 目录用 `trunk build --release` 构建");
}
