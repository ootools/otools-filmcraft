//! FilmCraft 的 OTools 插件 native 层。
//!
//! 把上游 `filmcraft-automation` 的 headless MCP 服务（进程内 Session，无窗口）编成宿主
//! 可加载的动态库，经宿主 MCP 网关对外暴露工具（见宿主 spec §5.4、§10.2）。
//!
//! 编译成两种形态：
//! - `cdylib`：插件市场里以 `lib/macOS.dylib` 等形式被宿主 `libloading` 加载，
//!   入口是 `otools_plugin_invoke` / `otools_plugin_free`；
//! - `rlib`：给测试与未来的独立 APP 壳直接引用。
//!
//! FFI 边界一律走 [`guard_invoke`]：插件里的 panic 不能跨 DLL 边界 unwind，
//! 否则宿主整个进程会被 `abort()` 掉。
//!
//! **为什么内联 FFI 守卫、不依赖主仓的 `ot-plugin-ffi`**：本仓是公开仓，
//! 而 `ootools/OTools` 主仓是私有仓，CI 拉不到；仓内既有先行者（designcraft / cadcraft /
//! pdfcraft / otools-vm）同样各自内联。逻辑一致，主仓那份是给主仓内插件用的。

pub mod service;

use serde_json::{json, Value};

fn dispatch(method: &str, payload: &Value) -> Result<Value, String> {
    match method {
        // 宿主 MCP 网关冻结的两个 method。
        "__otools_mcp_tools__" => Ok(json!({ "tools": service::list_tools()? })),
        "__otools_mcp_call__" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if name.trim().is_empty() {
                return Err("缺少工具名 name".to_string());
            }
            let arguments = payload
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            service::call_tool(name, &arguments)
        }
        // 上游 MCP 的 resources 能力（工程快照 / 命令目录），见 README「MCP」。
        "__otools_mcp_resources__" => Ok(json!({
            "resources": service::list_resources()?
                .get("resources")
                .cloned()
                .unwrap_or_else(|| json!([]))
        })),
        "__otools_mcp_resource_templates__" => Ok(service::list_resource_templates()?),
        "__otools_mcp_read_resource__" => {
            let uri = payload
                .get("uri")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if uri.trim().is_empty() {
                return Err("缺少资源 uri".to_string());
            }
            service::read_resource(uri)
        }
        // 宿主热更新前的停机握手：释放常驻 MCP 服务（runtime 线程、管道、上游会话）。
        // 上游没有 prompts（预设工作流）能力，但协议要求问到就得答得上：
        // 空表比 Unknown method 好——后者会让宿主每次建注册表都记一条错误日志。
        "__otools_mcp_prompts__" => Ok(json!({ "prompts": [] })),
        "__otools_mcp_get_prompt__" => Err("该插件不提供 prompt".to_string()),
        "__otools_shutdown__" => {
            service::shutdown();
            Ok(json!({
                "ok": true,
                "data": "otools-filmcraft-native 常驻 MCP 服务已释放"
            }))
        }
        other => Err(format!("Unknown method: {other}")),
    }
}

// ---------------------------------------------------------------- FFI

/// 在 FFI 边界内捕获 panic，返回宿主可解析的 JSON（与 designcraft / cadcraft 同形）。
fn guard_invoke<F>(
    input_ptr: *const u8,
    input_len: usize,
    output_len: *mut usize,
    logic: F,
) -> *mut u8
where
    F: FnOnce(&[u8]) -> Result<Value, String>,
{
    if input_ptr.is_null() || output_len.is_null() {
        return std::ptr::null_mut();
    }

    // SAFETY: 宿主保证 (input_ptr, input_len) 是可读区间。
    let input = unsafe { std::slice::from_raw_parts(input_ptr, input_len) };

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| logic(input)));

    let response = match outcome {
        Ok(Ok(value)) => {
            // 已带信封（如 __otools_shutdown__ 直接给了 {ok,data}）就不再包一层。
            if value.get("ok").is_some() {
                value
            } else {
                json!({ "ok": true, "data": value })
            }
        }
        Ok(Err(error)) => json!({ "ok": false, "error": error }),
        Err(payload) => {
            let message = payload
                .downcast_ref::<&str>()
                .map(|text| (*text).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            eprintln!("[filmcraft-native] 插件内部 panic: {message}");
            json!({ "ok": false, "error": format!("插件内部错误: {message}"), "panic": true })
        }
    };

    let mut bytes = serde_json::to_vec(&response)
        .unwrap_or_else(|_| br#"{"ok":false,"error":"serialize failed"}"#.to_vec());
    if bytes.is_empty() {
        bytes.extend_from_slice(b"{}");
    }
    let len = bytes.len();
    unsafe {
        *output_len = len;
    }
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

fn invoke_impl(input: &[u8]) -> Result<Value, String> {
    let parsed: Value =
        serde_json::from_slice(input).map_err(|error| format!("请求解析失败: {error}"))?;
    let method = parsed
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = parsed.get("payload").cloned().unwrap_or(Value::Null);
    dispatch(method, &payload)
}

#[no_mangle]
pub extern "C" fn otools_plugin_invoke(
    input_ptr: *const u8,
    input_len: usize,
    output_len: *mut usize,
) -> *mut u8 {
    guard_invoke(input_ptr, input_len, output_len, invoke_impl)
}

#[no_mangle]
pub extern "C" fn otools_plugin_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(ptr, len, len));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_rejects_missing_tool_name() {
        let error = dispatch("__otools_mcp_call__", &json!({})).unwrap_err();
        assert!(error.contains("name"), "got {error}");
    }

    #[test]
    fn dispatch_reports_unknown_method() {
        let error = dispatch("nope", &json!({})).unwrap_err();
        assert!(error.contains("Unknown method"), "got {error}");
    }

    #[test]
    fn invoke_impl_rejects_malformed_json() {
        let error = invoke_impl(b"not json").unwrap_err();
        assert!(error.contains("请求解析失败"), "got {error}");
    }

    #[test]
    fn shutdown_is_accepted() {
        let result = dispatch("__otools_shutdown__", &json!({})).unwrap();
        assert_eq!(result["ok"], true);
    }
}
