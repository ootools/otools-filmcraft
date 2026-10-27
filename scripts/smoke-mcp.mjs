#!/usr/bin/env node
/**
 * 按宿主的方式冒烟插件 dylib：dlopen 后走宿主冻结的那几个 MCP method，
 * 一次性检查「上游提供的能力一个都没丢」：
 *
 *   1. 工具面   上游工具表与 plugin.json 的 mcp.expose 双向一致（fullExpose=false 时
 *               只要求 expose ⊆ 上游，用于白名单是精选子集的插件）
 *   2. 注解     manifest 不得覆盖上游已有的 readOnly / destructive 语义
 *   3. 参数     schema 完整（object），且可选参数真能透传到上游
 *   4. 资源     上游 resources 必须能被列举与读取；未知 uri 必须报错；模板表要答得上
 *               （setup 可先跑一次调用，把依赖活动对象的资源喂饱）
 *   5. prompts  prompt 表必须与上游一致；至少要有一条能真渲染出消息；未知名字必须被拒
 *   6. 生命周期 未知工具归 isError、会话可复用、停机后可重建
 *
 * 宿主调用约定（见主仓 src-tauri/src/platform/native_plugins/core.rs）：
 *   输入 = JSON 字节，{"method": "...", "payload": {...}}
 *   输出 = (ptr, len)，响应形如 {"ok": true, "data": ...}
 *
 * 用法：node scripts/smoke-mcp.mjs <各 craft 仓库的共同父目录>
 * 例如在 otools-effectcraft 里：node scripts/smoke-mcp.mjs ..
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '..');

// probe：确定性的只读工具，用来验证会话可复用与参数透传
// args：probe 的可选参数；filterable=true 时要求「带参数」的返回值与「不带参数」不同
// resources / prompts：上游真正提供的清单。空数组 = 上游确实没有，
//   此时必须验证「列举为空」，而不是跳过——否则哪天上游加了而插件没接，
//   这里会静默放过。
// fullExpose=false：plugin.json 的 expose 是精选子集（不是全量），只校验不残留失效名字。
// setup：在列举资源前先跑一次工具调用，把「需要活动对象」的资源喂饱。
//   lightcraft 的 photo/active 与 develop/active 在没有活动照片时会由上游拒绝——
//   那不是插件缺陷，而是初始状态。setup 让冒烟覆盖到真实内容，而不是空表。
const plugins = {
  designcraft: {
    probe: 'list_commands',
    args: {},
    filterable: false,
    resources: ['designcraft://commands', 'designcraft://document'],
    prompts: [],
    fullExpose: false,
  },
  lightcraft: {
    probe: 'doc_inspect',
    args: {},
    filterable: false,
    // 导入一张 8x8 PNG：photo/active、develop/active 才有活动对象可读。
    setup: { tool: 'import', args: { paths: ['__SMOKE_IMAGE__'] } },
    resources: [
      'lightcraft://commands',
      'lightcraft://controls',
      'lightcraft://develop/active',
      'lightcraft://document',
      'lightcraft://library',
      'lightcraft://photo/active',
      'lightcraft://photos',
    ],
    prompts: [],
    fullExpose: false,
  },
  cadcraft: {
    probe: 'list_commands',
    args: {},
    filterable: false,
    resources: ['cadcraft://commands', 'cadcraft://drawing'],
    prompts: [],
    fullExpose: false,
  },
  pdfcraft: {
    probe: 'command_list',
    args: {},
    filterable: false,
    // 资源表是动态的：每打开一份文档多一组 pdfcraft://doc/{id}/…。
    // 这里锁的是「未开文档」这个初始态下的两条固定资源。
    resources: ['pdfcraft://commands', 'pdfcraft://document'],
    prompts: [],
    fullExpose: false,
  },
  vectorcraft: {
    probe: 'list_commands',
    args: {},
    filterable: false,
    resources: [
      'vectorcraft://commands',
      'vectorcraft://document',
      'vectorcraft://document/json',
    ],
    prompts: ['export-set', 'icon-set', 'poster', 'recolor', 'trace-and-style'],
    fullExpose: false,
  },
  effectcraft: {
    probe: 'list_commands',
    args: { filter: 'comp' },
    filterable: true,
    resources: ['effectcraft://document', 'effectcraft://commands'],
    prompts: [],
  },
  filmcraft: {
    probe: 'command_list',
    args: { filter: 'sequence' },
    filterable: true,
    resources: ['filmcraft://document', 'filmcraft://commands'],
    prompts: [],
  },
  photocraft: {
    probe: 'session_list',
    args: {},
    filterable: false,
    resources: ['photocraft://document', 'photocraft://commands'],
    prompts: [],
  },
  soundcraft: {
    probe: 'list_commands',
    args: { filter: 'track' },
    filterable: false,
    resources: ['soundcraft://session', 'soundcraft://commands'],
    prompts: [],
  },
};

// node 没有同步 FFI，用 python ctypes 做 dlopen。宿主契约就是「字节进、字节出」。
const py = String.raw`
import ctypes, json, sys
root, spec = sys.argv[1], json.loads(sys.argv[2])
name = spec["name"]

# setup 里需要一张真实图片（lightcraft 的 import）。写一个最小 PNG 到临时目录，
# 再把占位符替换成真实路径：冒烟脚本本身不该依赖仓库里的二进制夹具。
if spec.get("setup"):
    import base64, pathlib, tempfile
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4nGP8z8DAwMDAxMDA"
        "wMDAxMDAwMDAxMDAwMDAxMDAwMDAxMDAwMDAAAo1A/wG0k9oAAAAASUVORK5CYII=")
    img = pathlib.Path(tempfile.mkdtemp(prefix="otools-mcp-smoke-")) / "a.png"
    img.write_bytes(png)

    # 占位符可能在字符串里、也可能在列表里（paths: [...] 就是列表），所以递归替换：
    # 只比字符串会把列表原样留下，导入时变成"文件不存在"。
    def substitute(value):
        if value == "__SMOKE_IMAGE__":
            return str(img)
        if isinstance(value, list):
            return [substitute(v) for v in value]
        if isinstance(value, dict):
            return {k: substitute(v) for k, v in value.items()}
        return value

    spec["setup"]["args"] = {
        k: substitute(v) for k, v in (spec["setup"].get("args") or {}).items()
    }
path = f"{root}/otools-{name}/native/target/release/libotools_{name}_native.dylib"
lib = ctypes.CDLL(path)
lib.otools_plugin_invoke.restype = ctypes.POINTER(ctypes.c_char)
lib.otools_plugin_invoke.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
lib.otools_plugin_free.argtypes = [ctypes.POINTER(ctypes.c_char), ctypes.c_size_t]

def call(method, payload):
    raw = json.dumps({"method": method, "payload": payload}).encode()
    buf = ctypes.create_string_buffer(raw, len(raw))
    n = ctypes.c_size_t(0)
    ptr = lib.otools_plugin_invoke(buf, len(raw), ctypes.byref(n))
    if not ptr:
        raise SystemExit("otools_plugin_invoke 返回空指针")
    data = ctypes.string_at(ptr, n.value)
    lib.otools_plugin_free(ptr, n.value)
    return json.loads(data)

# MCP 规定 isError 缺省为 false（宿主也这么解析）。个别上游的成功响应不带这个字段，
# 所以这里按规范兜底，而不是要求每个上游都写全。
def is_error(resp):
    value = (resp.get("data") or {}).get("isError")
    return bool(value)

def text(resp):
    return "".join(
        b.get("text", "") for b in (resp["data"].get("content") or []) if b.get("type") == "text"
    )

tools_resp = call("__otools_mcp_tools__", {})
if not tools_resp.get("ok"):
    print(json.dumps({"fatal": "tools 调用失败", "resp": tools_resp}, ensure_ascii=False))
    raise SystemExit(1)
tools = tools_resp["data"]["tools"]
by_name = {t["name"]: t for t in tools}

bad_schema = [
    t["name"] for t in tools
    if not isinstance(t.get("inputSchema"), dict) or t["inputSchema"].get("type") != "object"
]

# setup：先跑一次调用，把依赖活动对象的资源喂饱（见上面 lightcraft 的说明）。
if spec.get("setup"):
    setup_resp = call("__otools_mcp_call__", {"name": spec["setup"]["tool"], "arguments": spec["setup"].get("args") or {}})
    if not setup_resp.get("ok") or is_error(setup_resp):
        print(json.dumps({"fatal": "setup 调用失败", "resp": setup_resp}, ensure_ascii=False))
        raise SystemExit(1)

plain = call("__otools_mcp_call__", {"name": spec["probe"], "arguments": {}})
withargs = call("__otools_mcp_call__", {"name": spec["probe"], "arguments": spec["args"]})
plain_len, with_len = len(text(plain)), len(text(withargs))
args_effect = (with_len != plain_len) if spec["filterable"] else True
probe_ok = plain.get("ok") and not is_error(plain)

unknown = call("__otools_mcp_call__", {"name": "definitely_not_a_tool", "arguments": {}})
unknown_is_error = unknown.get("ok") and unknown["data"].get("isError") is True

# ── resources ──────────────────────────────────────────────────────────────
# 期望值由调用方给出（每个插件的上游事实不同），这里只负责实测三件事：
#   列举到的 uri 集合、每条能否读回非空内容、未知 uri 是否被拒。
listed = call("__otools_mcp_resources__", {})
resource_error = None
if not listed.get("ok"):
    resource_error = str(listed.get("error"))
    listed_uris = []
else:
    listed_uris = sorted(
        r.get("uri") for r in (listed["data"].get("resources") or []) if r.get("uri")
    )

readable, read_empty, read_failed = [], [], {}
for uri in listed_uris:
    resp = call("__otools_mcp_read_resource__", {"uri": uri})
    if not resp.get("ok"):
        read_failed[uri] = str(resp.get("error"))
        continue
    contents = resp["data"].get("contents") or []
    body = contents[0] if contents else {}
    payload = body.get("text") or body.get("blob") or ""
    (readable if payload.strip() else read_empty).append(uri)

# 未知 uri 必须报错：resources 没有 isError 信封，宿主只能靠 ok=false 判断。
bogus = call("__otools_mcp_read_resource__", {"uri": "bogus://definitely-not-a-resource"})
unknown_resource_rejected = bogus.get("ok") is False

# 模板表：方法必须答得上（返回数组而不是 Unknown method）。
templates = call("__otools_mcp_resource_templates__", {})
templates_ok = templates.get("ok") is True
template_count = 0
if templates_ok:
    data = templates["data"] or {}
    template_count = len(data.get("resourceTemplates") or data.get("resource_templates") or [])

# ── prompts ────────────────────────────────────────────────────────────────
# 与 resources 同一套双向校验：上游有的必须报到，多报的也要抓。
prompts_resp = call("__otools_mcp_prompts__", {})
prompt_error = None
prompt_defs = []
if not prompts_resp.get("ok"):
    prompt_error = str(prompts_resp.get("error"))
else:
    prompt_defs = prompts_resp["data"].get("prompts") or []
prompt_names = sorted(p.get("name") for p in prompt_defs if p.get("name"))

# 至少渲染一条：用上游声明的 arguments 造一份占位参数（必填项给 "x"）。
rendered, prompt_render_errors = None, {}
for p in prompt_defs:
    args = {}
    for a in p.get("arguments") or []:
        if a.get("required"):
            args[a.get("name")] = "x"
    resp = call("__otools_mcp_get_prompt__", {"name": p["name"], "arguments": args})
    if resp.get("ok") and (resp["data"].get("messages") or []):
        rendered = p["name"]
        break
    prompt_render_errors[p["name"]] = str(resp.get("error") or "no messages")

# 未知 prompt 名必须被拒（名字来自客户端，不能打到插件上乱试）。
bogus_prompt = call("__otools_mcp_get_prompt__", {"name": "definitely_not_a_prompt", "arguments": {}})
unknown_prompt_rejected = bogus_prompt.get("ok") is False

again = call("__otools_mcp_call__", {"name": spec["probe"], "arguments": {}})
reusable = again.get("ok") and not is_error(again)

# 停机握手必须真释放，且之后能重建（宿主热更新路径）
shut = call("__otools_shutdown__", {})
rebuild = None
if shut.get("ok"):
    after = call("__otools_mcp_tools__", {})
    rebuild = after.get("ok") and len(after["data"].get("tools") or []) == len(tools)

print(json.dumps({
    "tools": len(tools),
    "names": sorted(by_name),
    "annotations": {
        n: {k: v for k, v in (t.get("annotations") or {}).items()
            if k in ("readOnlyHint", "destructiveHint")}
        for n, t in by_name.items()
    },
    "bad_schema": bad_schema,
    "probe_ok": probe_ok,
    "args_effect": args_effect,
    "plain_len": plain_len,
    "with_len": with_len,
    "unknown_is_error": unknown_is_error,
    "reusable": reusable,
    "shutdown_ok": bool(shut.get("ok")),
    "rebuild_after_shutdown": rebuild,
    "resources": {
        "listed": listed_uris,
        "readable": readable,
        "empty": read_empty,
        "failed": read_failed,
        "error": resource_error,
        "unknown_rejected": unknown_resource_rejected,
        "templates_ok": templates_ok,
        "templates": template_count,
    },
    "prompts": {
        "listed": prompt_names,
        "rendered": rendered,
        "render_errors": prompt_render_errors,
        "error": prompt_error,
        "unknown_rejected": unknown_prompt_rejected,
    },
}, ensure_ascii=False))
`;

let failures = 0;

for (const [name, spec] of Object.entries(plugins)) {
  let result;
  try {
    const out = execFileSync(
      process.env.PYTHON || 'python3',
      ['-c', py, root, JSON.stringify({ name, ...spec })],
      { encoding: 'utf8' },
    );
    result = JSON.parse(out.trim());
  } catch (error) {
    console.log(`${name.padEnd(13)} FAIL 运行时错误: ${String(error).slice(0, 300)}`);
    failures += 1;
    continue;
  }
  if (result.fatal) {
    console.log(`${name.padEnd(13)} FAIL ${result.fatal}`);
    failures += 1;
    continue;
  }

  const manifest = JSON.parse(
    readFileSync(path.join(root, `otools-${name}`, 'plugin.json'), 'utf8'),
  );

  // 1) 工具面：expose 不得含上游没有的名字；全量插件还要求不漏
  const expose = new Set(manifest.mcp?.expose ?? []);
  const upstream = new Set(result.names);
  const missing = spec.fullExpose === false
    ? []
    : [...upstream].filter((n) => !expose.has(n));
  const extra = [...expose].filter((n) => !upstream.has(n));

  // 2) manifest 不得覆盖上游已有的注解：覆盖会改变 seed 预勾选与风险分组
  const overrideConflicts = [];
  for (const [tool, declared] of Object.entries(manifest.mcp?.annotations ?? {})) {
    const upstreamAnn = result.annotations[tool] ?? {};
    for (const [key, value] of Object.entries(declared ?? {})) {
      const specKey = key === 'readOnly' ? 'readOnlyHint' : 'destructiveHint';
      if (!(specKey in upstreamAnn)) continue; // 上游没报，manifest 补是合法的
      if (upstreamAnn[specKey] !== value) {
        overrideConflicts.push(`${tool}.${key}: manifest=${value} 上游=${upstreamAnn[specKey]}`);
      }
    }
  }

  // 3) resources：期望 URI 与实际列举必须一致，且每条都能读回非空内容
  const expectedResources = [...(spec.resources ?? [])].sort();
  const actualResources = result.resources?.listed ?? [];
  const missingResources = expectedResources.filter((u) => !actualResources.includes(u));
  const extraResources = actualResources.filter((u) => !expectedResources.includes(u));
  // 列举到的每一条都必须能读：能列不能读等于给了个死链接。
  const unreadableResources = [
    ...(result.resources?.empty ?? []),
    ...Object.keys(result.resources?.failed ?? {}),
  ].filter((u) => actualResources.includes(u));

  // 4) prompts：清单双向一致；有 prompt 的插件至少要有一条能渲染出消息
  const expectedPrompts = [...(spec.prompts ?? [])].sort();
  const actualPrompts = result.prompts?.listed ?? [];
  const missingPrompts = expectedPrompts.filter((n) => !actualPrompts.includes(n));
  const extraPrompts = actualPrompts.filter((n) => !expectedPrompts.includes(n));
  const promptsMustRender = expectedPrompts.length > 0;
  const promptRenderOk = promptsMustRender ? result.prompts?.rendered != null : true;

  const ok =
    missing.length === 0 &&
    extra.length === 0 &&
    result.bad_schema.length === 0 &&
    result.probe_ok &&
    result.args_effect &&
    result.unknown_is_error &&
    result.reusable &&
    result.shutdown_ok &&
    result.rebuild_after_shutdown === true &&
    overrideConflicts.length === 0 &&
    missingResources.length === 0 &&
    extraResources.length === 0 &&
    unreadableResources.length === 0 &&
    result.resources?.error == null &&
    result.resources?.unknown_rejected === true &&
    result.resources?.templates_ok === true &&
    missingPrompts.length === 0 &&
    extraPrompts.length === 0 &&
    result.prompts?.error == null &&
    result.prompts?.unknown_rejected === true &&
    promptRenderOk;

  if (!ok) failures += 1;
  const resourceCount = actualResources.length;
  const templateCount = result.resources?.templates ?? 0;
  const promptCount = actualPrompts.length;
  console.log(
    `${name.padEnd(13)} ${ok ? 'OK  ' : 'FAIL'} tools=${result.tools} ` +
      `resources=${resourceCount}(+${templateCount} 模板) prompts=${promptCount} ` +
      `参数透传=${result.args_effect}(${result.plain_len}→${result.with_len}B) ` +
      `停机重建=${result.rebuild_after_shutdown}`,
  );
  for (const [label, list] of [
    ['expose 缺上游工具', missing],
    ['expose 含上游没有的', extra],
    ['schema 非 object', result.bad_schema],
    ['注解覆盖冲突', overrideConflicts],
    ['资源缺失（上游有、插件没报到）', missingResources],
    ['资源多报（上游没有、插件却报了）', extraResources],
    ['资源列得出但读不回来', unreadableResources],
    ['prompt 缺失（上游有、插件没报到）', missingPrompts],
    ['prompt 多报（上游没有、插件却报了）', extraPrompts],
  ]) {
    if (list.length) console.log(`   ${label}: ${JSON.stringify(list)}`);
  }
  if (result.resources?.error) {
    console.log(`   资源列举失败: ${result.resources.error}`);
  }
  if (result.resources?.unknown_rejected !== true) {
    console.log('   未知资源 uri 未被拒绝（应为 ok=false）');
  }
  if (result.resources?.templates_ok !== true) {
    console.log('   resources/templates/list 未答得上（应返回空表而非 Unknown method）');
  }
  if (result.prompts?.error) {
    console.log(`   prompt 列举失败: ${result.prompts.error}`);
  }
  if (result.prompts?.unknown_rejected !== true) {
    console.log('   未知 prompt 名未被拒绝（应为 ok=false）');
  }
  if (promptsMustRender && !promptRenderOk) {
    console.log(
      `   没有一条 prompt 能渲染出消息: ${JSON.stringify(result.prompts?.render_errors ?? {})}`,
    );
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 个插件失败`);
process.exit(failures === 0 ? 0 : 1);
