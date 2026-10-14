/** 只读核验 GitHub 标签归属，防止同版本产物覆盖另一次提交的发布。 */
import { pathToFileURL } from 'node:url';
export async function assertReleaseTarget(repo,tag,commit,access,fetcher=fetch) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag || '') || !/^[0-9a-f]{40,64}$/.test(commit || '')) throw new Error('发布仓库、标签或提交无效');
  if (!access || /\s/.test(access)) throw new Error('缺少 GitHub 发布凭证');
  const base=`https://api.github.com/repos/${repo}/git`;
  let url=`${base}/ref/tags/${encodeURIComponent(tag)}`;
  for (let depth=0;depth<8;depth++) {
    const response=await fetcher(url,{headers:{Authorization:`Bearer ${access}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',signal:AbortSignal.timeout(30000)});
    if (response.status===404 && depth===0) return;
    if (!response.ok) throw new Error(`查询发布标签失败（HTTP ${response.status}）`);
    const object=(await response.json()).object;
    if (!object || !/^[0-9a-f]{40,64}$/.test(object.sha || '')) throw new Error('GitHub 标签响应无效');
    if (object.type==='commit') {
      if (object.sha!==commit) throw new Error('现有标签指向其他提交，拒绝覆盖发布产物');
      return;
    }
    if (object.type!=='tag') throw new Error('发布标签未指向提交');
    url=`${base}/tags/${object.sha}`;
  }
  throw new Error('发布标签引用层级异常');
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  assertReleaseTarget(process.env.GITHUB_REPOSITORY,process.env.RELEASE_TAG,process.env.COMMIT_SHA,process.env.GH_TOKEN)
    .then(()=>console.log('发布标签与构建提交一致，或标签尚不存在'))
    .catch(error=>{console.error(error.message);process.exitCode=1;});
}
