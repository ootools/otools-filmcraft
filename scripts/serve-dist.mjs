/**
 * 把 dist/ 当静态站点跑起来（本地试 dist/ 用；不进插件分发）。
 * 用法：node scripts/serve-dist.mjs [端口]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(repoRoot, 'dist');
const port = Number(process.argv[2] || 6483);

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html 不存在，先跑 node scripts/build-wasm.mjs');
  process.exit(1);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(dist, rel);
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // 需要 SharedArrayBuffer 的实验性路径时可以用这个头（默认关掉）
      // 'cross-origin-opener-policy': 'same-origin',
      // 'cross-origin-embedder-policy': 'require-corp',
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${port}/  （Ctrl+C 结束）`);
    console.log('参数：?webgl 强制 WebGL2 · ?cpu 用 egui 形状画布 · ?sample 示例图纸 · ?theme=dark|light');
  });
