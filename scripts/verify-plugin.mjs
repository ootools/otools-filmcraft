/**
 * 校验 .oplg 发布包（otools-aigv/scripts/verify-plugin.py 的 node 版）。
 * ------------------------------------------------------------------
 * 检查：摘要清单、包内 plugin.json 合法性、ZIP 结构与 CRC、
 * entry 与 logo.svg 是否在包里、以及「正式包不能启用开发模式」。
 *
 * 用法：node scripts/verify-plugin.mjs [dist-pack]
 */
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(root, process.argv[2] || 'dist-pack');

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const ok = (message) => console.log(`✓ ${message}`);

/** 最小 ZIP 读取器：走中央目录，逐个条目解压并核对 CRC32 */
function readZip(buffer) {
  // EOCD：从尾部往前找 0x06054b50
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 65535; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP：找不到 EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`中央目录项 #${i} 签名异常`);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`本地头签名异常：${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = compressedSize === uncompressedSize && crc === 0 && uncompressedSize === 0
      ? Buffer.alloc(0)
      : (() => {
          try {
            return inflateRawSync(raw);
          } catch {
            // method 0（存储）时无需解压
            return Buffer.from(raw);
          }
        })();
    entries.push({ name, crc, data, compressedSize, uncompressedSize });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const crc32 = (buffer) => {
  // 与 node:zlib 的 crc32 一致（pack-plugin.mjs 打包时用的就是它）
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
};

function main() {
  if (!fs.existsSync(directory)) fail(`目录不存在：${directory}`);

  const manifestPath = path.join(directory, 'plugin.json');
  if (!fs.existsSync(manifestPath)) fail('缺少 plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const { packid, version } = manifest;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packid || '')) fail(`packid 非法：${packid}`);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version || '')) fail(`version 非法：${version}`);
  ok(`plugin.json 合法：${packid}@${version}`);

  // 摘要清单必须刚好覆盖这三个文件
  const sumsPath = path.join(directory, 'SHA256SUMS');
  if (!fs.existsSync(sumsPath)) fail('缺少 SHA256SUMS');
  const filename = `${packid}-${version}.oplg`;
  const expected = new Set([filename, 'plugin.json', 'logo.svg']);
  const checksums = new Map();
  for (const line of fs.readFileSync(sumsPath, 'utf8').split('\n').filter(Boolean)) {
    const [digest, name] = line.split('  ');
    if (!/^[0-9a-f]{64}$/.test(digest) || !expected.has(name) || checksums.has(name)) fail(`摘要清单无效：${line}`);
    checksums.set(name, digest);
  }
  if (checksums.size !== expected.size) fail('摘要清单不完整或混入其他版本');
  for (const [name, digest] of checksums) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex');
    if (actual !== digest) fail(`摘要不匹配：${name}`);
  }
  ok(`SHA256SUMS 覆盖 ${checksums.size} 个文件且全部匹配`);

  // 正式包不能启用开发模式
  if (manifest.devUrl) fail('正式包不能启用开发模式（devUrl）');
  if (manifest.quickDev) fail('正式包不能启用开发模式（quickDev）');
  ok('已去除 devUrl / quickDev');

  // ZIP 结构与 CRC
  const oplg = path.join(directory, filename);
  const entries = readZip(fs.readFileSync(oplg));
  const names = entries.map((e) => e.name);
  if (names.length !== new Set(names).size) fail('ZIP 含重复文件');
  for (const name of names) {
    if (name.includes('\\')) fail(`ZIP 路径含反斜杠：${name}`);
    const pure = path.posix.normalize(name);
    if (pure.startsWith('/') || pure.split('/').includes('..')) fail(`ZIP 路径非法：${name}`);
  }
  for (const entry of entries) {
    const actual = crc32(entry.data);
    if (actual !== entry.crc) fail(`CRC 校验失败：${entry.name}`);
    if (entry.data.length !== entry.uncompressedSize) fail(`解压后大小不符：${entry.name}`);
  }
  ok(`ZIP ${entries.length} 个条目，CRC 全部通过`);

  if (!names.includes(String(manifest.entry))) fail(`ZIP 缺少入口：${manifest.entry}`);
  if (!names.includes('logo.svg')) fail('ZIP 缺少 logo.svg');
  ok(`入口 ${manifest.entry} 与 logo.svg 都在包内`);

  // 入口 HTML 必须是 dist/ 下那份（防止打包到陈旧产物）
  const entryData = entries.find((e) => e.name === manifest.entry).data.toString('utf8');
  if (!entryData.includes('filmcraftOtools')) fail('入口 HTML 里没有 OTools 桥（window.filmcraftOtools）');
  ok('入口 HTML 含 OTools 宿主桥');

  const wasm = entries.filter((e) => e.name.endsWith('.wasm'));
  if (wasm.length === 0) fail('包内没有 .wasm');
  ok(`wasm 产物：${wasm.map((e) => `${e.name} ${(e.data.length / 1048576).toFixed(1)}MB`).join(', ')}`);

  console.log(`\n${filename} 校验通过（${entries.length} 个条目）。`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
