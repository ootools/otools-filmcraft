//! OTools 宿主桥（`window.filmcraftOtools` 的 wasm-bindgen 绑定）。
//!
//! JS 侧的实现见 `shell/index.html`。宿主能力有两条路（宿主包装 API 与 Tauri 原生 IPC），
//! JS 里已经统一处理，这里只关心四个函数。

use std::cell::Cell;

use base64::Engine as _;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::js_sys;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = filmcraftOtools, js_name = "available")]
    fn host_available() -> bool;

    #[wasm_bindgen(js_namespace = filmcraftOtools, js_name = "theme")]
    fn host_theme() -> String;

    /// 宿主界面语言（BCP 47，如 `zh-CN`）：OTools 注入到插件 webview 的
    /// `window.__OTOOLS_LOCALE__.locale` / `document.documentElement.lang`。
    #[wasm_bindgen(js_namespace = filmcraftOtools, js_name = "language")]
    fn host_language_raw() -> String;

    /// `{title, extensions}` → `[{name, path, dataBase64}]`。
    #[wasm_bindgen(js_namespace = filmcraftOtools, js_name = "openFiles")]
    fn host_open_files(request: JsValue) -> js_sys::Promise;

    /// `{name, dataBase64, forcePick}` → `{path}` 或 `null`（用户取消）。
    #[wasm_bindgen(js_namespace = filmcraftOtools, js_name = "saveFile")]
    fn host_save_file(request: JsValue) -> js_sys::Promise;

    /// 宿主投递的「打开方式」：JS 侧已把文件读成字节攒好，这里一次取走。
    #[wasm_bindgen(js_namespace = filmcraftOtools, js_name = "takeDelivered")]
    fn take_delivered_raw() -> js_sys::Array;
}

thread_local! {
    /// 下一次保存是否**必须**弹另存对话框（「另存为」置真，「保存」用上次的路径）。
    static FORCE_PICK: Cell<bool> = const { Cell::new(false) };
}

/// 一次打开的结果：`(文件名, 宿主的真实路径, 字节)`。
pub type OpenedFile = (String, String, Vec<u8>);

pub fn available() -> bool {
    host_available()
}

pub fn theme() -> String {
    host_theme()
}

pub fn host_language() -> String {
    host_language_raw()
}

/// 社区/外部链接（Discord、ArtCraft 官网、上游 GitHub）：在 OTools 插件里点这些
/// 会把用户拽到外部，让插件不纯粹。`open_url` 钩子对命中者返回 `Ok(())` 静默吞掉。
pub fn is_community_link(url: &str) -> bool {
    url.contains("discord.gg") || url.contains("getartcraft.com") || url.contains("github.com/storytold")
}

/// 取走宿主投递的文件：工程走 `file.open`，其余素材走 `file.import`
/// （与「文件 ▸ 打开工程」「文件 ▸ 导入」同一条路，字节先登记进 `host::put`）。
///
/// 方向与保存相反：宿主在系统里双击已绑定扩展名的文件 → 投递队列 →
/// 本函数取走 → 引擎命令。
pub fn drain_delivered() {
    for item in take_delivered_raw().iter() {
        if !item.is_object() {
            continue;
        }
        let name = field(&item, "name").unwrap_or_else(|| "Untitled.fcproj".to_string());
        let data = field(&item, "dataBase64").unwrap_or_default();
        let path = field(&item, "path")
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| format!("/{name}"));
        let bytes = match decode(&data) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::error!("delivered file {name}: {e}");
                continue;
            }
        };
        let is_project = path.to_ascii_lowercase().ends_with(".fcproj");
        crate::host::put(path.clone(), bytes);
        crate::host::post(move |app| {
            let result = if is_project {
                app.session.execute("file.open", serde_json::json!({ "path": path }))
            } else {
                let bin = app.import_bin().0;
                app.session.execute("file.import", serde_json::json!({ "paths": [path], "bin": bin }))
            };
            if let Err(e) = result {
                app.status(format!("打开失败：{e}"));
            }
        });
    }
}
pub fn force_pick(force: bool) {
    FORCE_PICK.with(|flag| flag.set(force));
}

fn take_force() -> bool {
    FORCE_PICK.with(|flag| flag.replace(false))
}

pub fn open_request(title: &str, exts: &[&str]) -> JsValue {
    let request = js_sys::Object::new();
    let arr = js_sys::Array::new();
    for e in exts {
        arr.push(&JsValue::from_str(e));
    }
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("title"), &JsValue::from_str(title));
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("extensions"), &arr);
    request.into()
}

/// 弹宿主的打开对话框并读出选中的文件。
pub async fn open_files(request: &JsValue) -> Result<Vec<OpenedFile>, String> {
    let value = JsFuture::from(host_open_files(request.clone())).await.map_err(js_error)?;
    let mut out = Vec::new();
    for entry in js_sys::Array::from(&value).iter() {
        let name = field(&entry, "name").unwrap_or_else(|| "Untitled.fcproj".to_string());
        let path = field(&entry, "path").unwrap_or_else(|| name.clone());
        let data = field(&entry, "dataBase64").unwrap_or_default();
        let bytes = decode(&data)?;
        out.push((name, path, bytes));
    }
    Ok(out)
}

/// 把字节交给宿主写盘；返回落盘的真实路径，`None` = 用户取消。
pub async fn save_file(name: &str, data_base64: &str) -> Result<Option<String>, String> {
    let request = save_request(name, data_base64, take_force());
    let value = JsFuture::from(host_save_file(request)).await.map_err(js_error)?;
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    Ok(field(&value, "path"))
}

fn save_request(name: &str, data: &str, force_pick: bool) -> JsValue {
    let request = js_sys::Object::new();
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("name"), &JsValue::from_str(name));
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("dataBase64"), &JsValue::from_str(data));
    let _ = js_sys::Reflect::set(&request, &JsValue::from_str("forcePick"), &JsValue::from_bool(force_pick));
    request.into()
}

pub fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn decode(data: &str) -> Result<Vec<u8>, String> {
    if data.is_empty() {
        return Err("宿主返回的文件内容为空".into());
    }
    base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("宿主返回的内容不是合法的 base64：{e}"))
}

fn field(value: &JsValue, key: &str) -> Option<String> {
    js_sys::Reflect::get(value, &JsValue::from_str(key)).ok()?.as_string()
}

fn js_error(e: JsValue) -> String {
    e.as_string().unwrap_or_else(|| format!("{e:?}"))
}
