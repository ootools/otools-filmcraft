//! 宿主侧的文件服务：给引擎一个「能读写宿主机磁盘」的 `Services`。
//!
//! 上游 `apps/filmcraft-web` 用一张虚拟文件表（Blob + 分块读）喂给引擎。OTools 里
//! 我们换成：宿主对话框选真实路径 → 通过 `readHostFile` 把字节读进内存缓存 →
//! 引擎按这个路径访问；保存时把字节交给 `writeHostFile`。
//!
//! 随机访问：已实现 `Services::reader()` 返回基于内存缓存 `Arc<[u8]>` 的 `CacheReader`，
//! 引擎对素材做定位读取 / 流式解码，不再每次 `read_file` 整段克隆。
//! 已知限制：字节仍整文件驻留内存（读素材时一次性 base64 解码进缓存）。要彻底不占内存，
//! 需要宿主按 range 直读磁盘（见 `reader()` 内的注释）。

use std::cell::RefCell;
use std::collections::HashMap;
use std::io;
use std::sync::Arc;

use filmcraft_engine::Services;
use filmcraft_media::ByteReader;
use filmcraft_ui_egui::FilmcraftApp;

/// 下一帧在应用上执行的动作（异步读文件完成后要打开/导入时用）。
pub type Action = Box<dyn FnOnce(&mut FilmcraftApp)>;

thread_local! {
    /// 「宿主路径 → 字节」：引擎访问文件时从这里取。
    /// 用 `Arc<[u8]>` 而非 `Vec<u8>`，这样 `reader()` 能把同一份字节零拷贝地交给
    /// 引擎做随机访问，而不用每次 `read_file` 再克隆整段。
    // HashMap::new 不是 const fn，所以这里不能用 `const {}` 块。
    static FILES: RefCell<HashMap<String, Arc<[u8]>>> = RefCell::new(HashMap::new());
    static ACTIONS: RefCell<Vec<Action>> = const { RefCell::new(Vec::new()) };
}

/// 把读到的字节登记在 `path` 下。
pub fn put(path: String, bytes: Vec<u8>) {
    FILES.with(|files| {
        files.borrow_mut().insert(path, Arc::from(bytes));
    });
}

/// 排一个在下一帧执行的动作（异步任务完成后用）。
pub fn post(f: impl FnOnce(&mut FilmcraftApp) + 'static) {
    ACTIONS.with(|a| a.borrow_mut().push(Box::new(f)));
}

/// 每帧取出排队的动作执行（由 `Shell::logic` 调用）。
pub fn pump(app: &mut FilmcraftApp) {
    let actions = ACTIONS.with(|a| std::mem::take(&mut *a.borrow_mut()));
    for f in actions {
        f(app);
    }
}

/// 工程的 `Services`：读走内存缓存，写走宿主另存对话框。
pub struct HostServices;

impl Services for HostServices {
    fn read_file(&self, path: &str) -> io::Result<Vec<u8>> {
        FILES.with(|files| files.borrow().get(path).map(|b| b.to_vec()))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{path}：不在宿主缓存里，请用宿主对话框重新打开")))
    }

    fn write_file(&self, path: &str, data: &[u8]) -> io::Result<()> {
        put(path.to_string(), data.to_vec());
        let name = file_name(path);
        let encoded = crate::otools::encode(data);
        wasm_bindgen_futures::spawn_local(async move {
            match crate::otools::save_file(&name, &encoded).await {
                Ok(Some(path)) => log::info!("已保存 {name} -> {path}"),
                Ok(None) => log::warn!("保存被取消：{name}"),
                Err(e) => log::error!("保存失败：{e}"),
            }
        });
        Ok(())
    }

    fn file_size(&self, path: &str) -> io::Result<u64> {
        FILES.with(|files| files.borrow().get(path).map(|b| b.len() as u64))
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{path}：不在宿主缓存里")))
    }

    /// 随机访问 reader：直接把内存缓存里的 `Arc<[u8]>` 零拷贝交给引擎，让它做
    /// 定位读取 / 流式解码，而不用每次 `read_file` 再克隆整段（剪 4K 长素材时
    /// 能省下大量整段拷贝）。注意：字节仍然整文件驻留内存——要彻底不占内存，
    /// 需要宿主按 range 直读磁盘（见下方注释），那一步要补 worker+Atomics 桥。
    fn reader(&self, path: &str) -> Option<io::Result<filmcraft_media::SharedReader>> {
        FILES.with(|files| files.borrow().get(path).cloned())
            .map(|arc| Ok(Arc::new(CacheReader(arc)) as filmcraft_media::SharedReader))
    }

    /// 定位读取：从内存缓存里切一段，比默认实现（`read_file` 整段克隆再切片）省一次全拷贝。
    fn read_range(&self, path: &str, offset: u64, len: usize) -> io::Result<Vec<u8>> {
        let arc = FILES.with(|files| files.borrow().get(path).cloned())
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{path}：不在宿主缓存里")))?;
        let a = usize::try_from(offset).map_err(|_| io::Error::new(io::ErrorKind::UnexpectedEof, "offset 越界"))?;
        let end = (a + len).min(arc.len());
        if a > end {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "read past end"));
        }
        Ok(arc[a..end].to_vec())
    }

    /// 图像序列帧按需读取：引擎解码序列时按帧路径来取，仍走内存缓存。
    fn file_loader(&self) -> Option<filmcraft_media::sequence::FrameLoader> {
        Some(Arc::new(|path: &str| {
            FILES.with(|files| files.borrow().get(path).map(|b| b.to_vec()))
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{path}：不在宿主缓存里")))
        }))
    }

    /// 导出先在内存里编码好再交给 `write_file`（和上游网页版一致）。
    fn export_in_memory(&self) -> bool {
        true
    }
}

/// 包一层内存缓存的 `Arc<[u8]>`，实现 `ByteReader` 给引擎做随机访问。
struct CacheReader(Arc<[u8]>);

impl ByteReader for CacheReader {
    fn len(&self) -> u64 {
        self.0.len() as u64
    }
    fn read_at(&self, offset: u64, buf: &mut [u8]) -> io::Result<()> {
        let a = usize::try_from(offset).map_err(|_| io::Error::new(io::ErrorKind::UnexpectedEof, "offset 越界"))?;
        let src = self.0
            .get(a..a.checked_add(buf.len()).ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "长度溢出"))?)
            .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "read past end"))?;
        buf.copy_from_slice(src);
        Ok(())
    }
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Untitled.fcproj".into())
}

/// 「文件 ▸ 导入」：弹宿主的打开对话框，把选中的素材读进来再交给引擎。
pub fn pick_files(exts: &[&str]) {
    let request = crate::otools::open_request("导入媒体", exts);
    wasm_bindgen_futures::spawn_local(async move {
        let files = match crate::otools::open_files(&request).await {
            Ok(files) => files,
            Err(e) => {
                log::error!("导入失败：{e}");
                return;
            }
        };
        let mut paths = Vec::new();
        for (_name, path, bytes) in files {
            put(path.clone(), bytes);
            paths.push(path);
        }
        if paths.is_empty() {
            return;
        }
        post(move |app| {
            let bin = app.import_bin().0;
            match app.session.execute("file.import", serde_json::json!({ "paths": paths, "bin": bin })) {
                Ok(_) => {}
                Err(e) => app.status(format!("导入失败：{e}")),
            }
        });
    });
}

/// 「文件 ▸ 打开工程」。
pub fn pick_project() {
    let request = crate::otools::open_request("打开工程", &["fcproj"]);
    wasm_bindgen_futures::spawn_local(async move {
        let files = match crate::otools::open_files(&request).await {
            Ok(files) => files,
            Err(e) => {
                log::error!("打开工程失败：{e}");
                return;
            }
        };
        let Some((_name, path, bytes)) = files.into_iter().next() else { return };
        put(path.clone(), bytes);
        post(move |app| {
            if let Err(e) = app.session.execute("file.open", serde_json::json!({ "path": path })) {
                app.status(format!("打开失败：{e}"));
            }
        });
    });
}
