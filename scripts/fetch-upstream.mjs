/**
 * 按 upstream.pin 拉取上游源码到 upstream/（该目录被 .gitignore 忽略，**不入库**）。
 *
 * 为什么这么干：五个 ArtCraft 上游单个快照 16~38 MB、合计约 150 MB，
 * subtree/submodule 会把这部分永远塞进我们的仓库（且每次同步只会涨不会降）。
 * 这里改成「只记一个 commit SHA + 按需浅拉取」，仓库保持几十 KB，
 * 而且 pin 到精确 SHA 比跟分支跑更可复现。
 *
 * GitHub 支持按任意可达 commit 做 --depth 1 拉取，所以一次拉取只需下载那一棵树。
 *
 * 用法：
 *   node scripts/fetch-upstream.mjs            # 缺失才拉，已在 pinned commit 就跳过
 *   node scripts/fetch-upstream.mjs --force    # 丢弃本地改动，强制回到 pinned commit
 *   node scripts/fetch-upstream.mjs --check    # 只检查是否已对齐（不拉取）
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const checkOnly = argv.includes('--check');
const pinPath = path.join(repoRoot, 'upstream.pin');
const upstreamDir = path.join(repoRoot, 'upstream');

if (!fs.existsSync(pinPath)) {
  console.error('缺少 upstream.pin（应含 upstream/ssh/https/commit 字段）');
  process.exit(1);
}
const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
if (!/^[0-9a-f]{40}$/.test(pin.commit ?? '')) {
  console.error('upstream.pin 的 commit 必须是 40 位完整 SHA（否则无法保证可复现）');
  process.exit(1);
}

// GIT_TERMINAL_PROMPT=0：CI 里取不到凭证时立刻失败，不要卡在交互输入上。
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

const exec = (args, cwd) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });

const shortSha = pin.commit.slice(0, 12);

function currentHead() {
  const r = exec(['rev-parse', 'HEAD'], upstreamDir);
  return r.status === 0 ? r.stdout.trim() : null;
}

// 已经是 pinned commit 且没有脏改动：直接跳过（省一次几十 MB 的下载）。
if (!force && fs.existsSync(path.join(upstreamDir, '.git'))) {
  const head = currentHead();
  if (head === pin.commit) {
    const dirty = exec(['status', '--porcelain'], upstreamDir).stdout.trim();
    if (!dirty) {
      console.log(`upstream/ 已是 ${pin.upstream}@${shortSha}，跳过拉取。`);
      process.exit(0);
    }
    console.log('upstream/ 有本地改动，重新拉取对齐 pinned commit。');
  }
}

if (checkOnly) {
  const head = currentHead();
  if (head === pin.commit) {
    console.log(`已对齐 ${shortSha}`);
    process.exit(0);
  }
  console.error(`未对齐：期望 ${pin.commit}，实际 ${head ?? '（上游目录不存在）'}`);
  process.exit(1);
}

const transports = [
  ['ssh', pin.ssh],
  ['https', pin.https],
].filter(([, url]) => Boolean(url));

for (const [label, url] of transports) {
  console.log(`▸ 从 ${label} 拉取 ${shortSha} …`);

  fs.mkdirSync(upstreamDir, { recursive: true });
  if (!fs.existsSync(path.join(upstreamDir, '.git'))) {
    const init = exec(['init', '-q'], upstreamDir);
    if (init.status !== 0) {
      console.error(`  git init 失败：${init.stderr?.trim()}`);
      continue;
    }
  }
  // remove 在不存在时会失败，忽略即可；add 才是必须的。
  exec(['remote', 'remove', 'origin'], upstreamDir);
  const added = exec(['remote', 'add', 'origin', url], upstreamDir);
  if (added.status !== 0) {
    console.error(`  git remote add 失败：${added.stderr?.trim()}`);
    continue;
  }

  let fetched = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const r = exec(['fetch', '--depth', '1', 'origin', pin.commit], upstreamDir);
    if (r.status === 0) {
      fetched = true;
      break;
    }
    const reason = `${r.stderr || r.stdout || ''}`.trim().split('\n')[0];
    console.error(`  第 ${attempt} 次失败：${reason}`);
  }
  if (!fetched) continue;

  // `-f` 是必须的：上游目录是只读构建输入，工作区里的换行符/时间戳差异会让
  // 普通 checkout 直接 abort（AGENTS.md：上游一行都不要改，丢了不心疼）。
  const checkout = exec(['checkout', '-f', '--detach', 'FETCH_HEAD'], upstreamDir);
  if (checkout.status !== 0) {
    console.error(`  检出失败：${checkout.stderr?.trim()}`);
    continue;
  }

  const got = currentHead();
  if (got !== pin.commit) {
    console.error(`  SHA 不符：期望 ${pin.commit}，实际 ${got}`);
    continue;
  }

  console.log(`✓ 成功（${label}）：${pin.upstream}@${shortSha}`);
  console.log(`upstream/ 已就位 → ${upstreamDir}`);
  process.exit(0);
}

console.error('全部通道都失败：SSH 需要本机配好 GitHub key，HTTPS 需要能直连 github.com。');
process.exit(1);
