/** 独立插件发布：显式选择认证方式，秘密仅在当前进程使用，不写入 artifact/job outputs。 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('发布服务必须使用 HTTPS');
  return url;
}
function token(value) {
  const result=String(value || '').replace(/^Bearer\s+/i,'');
  if (!result || /\s/.test(result)) throw new Error('认证凭证缺失或格式无效');
  return result;
}
async function jsonRequest(fetcher,url,options={}) {
  const res=await fetcher(httpsUrl(url),{...options, redirect:'error',signal:AbortSignal.timeout(30000)});
  if (!res.ok) throw new Error(`授权或发布请求失败（HTTP ${res.status}）`);
  const data=await res.json();
  if (data.code!==undefined && Number(data.code)!==200) throw new Error(`授权或发布被拒绝（业务码 ${data.code}）`);
  return data;
}
export async function credential(mode,env,fetcher=fetch,mask=value=>console.log(`::add-mask::${value}`)) {
  const keys={pat:'XYCLOUD_PAT',login:'XYCLOUD_LOGIN_TOKEN',shared:'OTOOLS_MARKET_TOKEN'};
  if (keys[mode]) { const value=token(env[keys[mode]]); mask(value); return value; }
  if (mode!=='oidc') throw new Error('未知发布认证方式');
  if (!env.XYCLOUD_OIDC_ISSUER || !env.XYCLOUD_PUBLISHER_ID) throw new Error('请先配置 OIDC 兑换地址和可信发布绑定 ID');
  const url=httpsUrl(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience',env.XYCLOUD_OIDC_AUDIENCE || 'otools-ci');
  const github=await jsonRequest(fetcher,url,{headers:{Authorization:`Bearer ${token(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)}`}});
  const jwt=token(github.value); mask(jwt);
  const result=await jsonRequest(fetcher,env.XYCLOUD_OIDC_ISSUER,{method:'POST',headers:{Authorization:`Bearer ${jwt}`,'Content-Type':'application/json'},
    body:JSON.stringify({publisherId:env.XYCLOUD_PUBLISHER_ID,scope:'otools:plugin:publish'})});
  const access=token(result.data?.access_token); mask(access); return access;
}
export function releaseMeta(manifest,override='',tag='') {
  const version=override || manifest.version;
  if (typeof version!=='string' || /\s/.test(version) || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('版本号无效');
  const packid=manifest.packid;
  if (typeof packid!=='string' || packid.length>128 || /\s/.test(packid) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(packid)) throw new Error('packid 无效');
  if (tag && tag!==`v${version}`) throw new Error('tag 与 plugin.json 版本不一致');
  return {version,packid,release_tag:tag || `plugin-${packid}-v${version}`};
}
/** 同一份生产清单用于包内文件及市场元数据，开发配置保留在源文件中。 */
export function productionManifest(manifest,version='') {
  const meta=releaseMeta(manifest,version);
  const entry=manifest.entry;
  if (typeof entry!=='string' || !entry || entry.startsWith('/') || entry.includes('\\') || entry.includes(':') || entry.split('/').some(part=>!part || part==='..' || part==='.')) throw new Error('插件 entry 必须是包内相对路径');
  const result={...manifest,version:meta.version};
  delete result.devUrl;
  delete result.quickDev;
  // native 插件的 autoReload 是开发期热重载开关（宿主监听动态库变化），
  // 正式包必须关掉，与 devUrl / quickDev 同理。
  if (result.native && typeof result.native==='object') {
    result.native={...result.native,autoReload:false};
  }
  return result;
}
function booleanInput(value,fallback) {
  if (value===undefined || value==='') return fallback;
  if (value===true || value==='true') return true;
  if (value===false || value==='false') return false;
  throw new Error('发布开关必须为 true 或 false');
}
/** 工作流直接使用这些输出控制写操作，dry-run 不能创建 Release 或提交市场。 */
export function releasePlan(env) {
  const event=env.EVENT_NAME || 'workflow_dispatch';
  if (!['push','workflow_dispatch'].includes(event)) throw new Error('不允许此事件发布插件');
  if (event==='push' && !/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(env.RELEASE_SOURCE_TAG || '')) throw new Error('只允许版本标签触发自动发布');
  const publish=event==='push' || !booleanInput(env.DRY_RUN,true);
  const market=event==='push'?booleanInput(env.AUTO_PUBLISH_MARKET,false):booleanInput(env.PUBLISH_MARKET,false);
  return {publish_enabled:publish,market_requested:market,market_enabled:publish && market,validate_release:publish || market};
}
export function validateAuthConfig(mode,env) {
  if (mode==='pat') {
    if (!/^xy_pat_[0-9a-fA-F]{64}$/.test(token(env.XYCLOUD_PAT))) throw new Error('XYCLOUD_PAT 格式无效，请使用平台个人访问令牌');
  } else if (mode==='login') token(env.XYCLOUD_LOGIN_TOKEN);
  else if (mode==='shared') token(env.OTOOLS_MARKET_TOKEN);
  else if (mode==='oidc') {
    httpsUrl(env.XYCLOUD_OIDC_ISSUER);
    token(env.XYCLOUD_PUBLISHER_ID);
  } else throw new Error('未知发布认证方式');
  if (env.OTOOLS_MARKET_API) httpsUrl(env.OTOOLS_MARKET_API);
}
export function marketPayload(manifest,repo,tag,version) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Error('GitHub 仓库名称无效');
  const base=`https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
  // logo 不能用 Release 资产下载链：GitHub 会 302 到
  // application/octet-stream + Content-Disposition: attachment，
  // Chromium（OTools 的 WebView2）的 <img> 直接拒载，市场上显示不出图标。
  // 改用 raw.githubusercontent.com 上同一 tag 的仓库文件：返回 image/svg+xml，
  // 可直接渲染，且随 tag 固定不会漂移。
  const logo=`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tag)}/logo.svg`;
  return {...productionManifest(manifest,version),packageUrl:`${base}/${manifest.packid}-${version}.oplg`,logo};
}
export async function publishMarket(url,access,payload,fetcher=fetch) {
  const result=await jsonRequest(fetcher,url,{method:'POST',headers:{Authorization:`Bearer ${token(access)}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if (Number(result.code)!==200) throw new Error('市场未返回明确的成功状态');
  return result;
}
async function main() {
  const env=process.env;
  if (process.argv[2]==='preflight') {
    validateAuthConfig(env.AUTH_MODE,env);
    console.log('市场认证配置格式检查通过（未请求市场、未发布）');
    return;
  }
  const manifest=JSON.parse(fs.readFileSync(env.PLUGIN_MANIFEST || 'plugin.json','utf8'));
  if (process.argv[2]==='meta') {
    const meta={...releaseMeta(manifest,env.DISPLAY_VERSION||'',env.RELEASE_SOURCE_TAG||''),...releasePlan(env)};
    for(const [k,v] of Object.entries(meta)) fs.appendFileSync(env.GITHUB_OUTPUT,`${k}=${v}\n`);
    return;
  }
  validateAuthConfig(env.AUTH_MODE,env);
  const access=await credential(env.AUTH_MODE,env);
  await publishMarket(env.OTOOLS_MARKET_API || 'https://otools-api.lingyun.net/api/v1/otools/plugin/publish',access,
    marketPayload(manifest,env.GITHUB_REPOSITORY,env.RELEASE_TAG,env.RELEASE_VERSION));
  console.log('插件市场已确认发布成功');
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
