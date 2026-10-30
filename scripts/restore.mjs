#!/usr/bin/env node
// restore: 把 backup.mjs 做的加密备份解回明文. 只依赖 Node 自带模块, 新电脑装好 Node 18+ 就能跑.
// backup.mjs 每次会把本文件复制进加密仓库根目录, clone 下来直接在仓库里跑.
// 用法: node restore.mjs --to <空目录> [--key <密码文件>] [--only <前缀, 如 notes/>] [--from <仓库目录, 默认本文件所在目录>]
//       不给 --key 就在命令行里问密码.
// 退出码: 0 成功 / 1 参数或密码错 / 3 有文件解不开或校验不对 (其余照常解出, 清单在输出里)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const FROM = path.resolve(opt('--from') || path.dirname(fileURLToPath(import.meta.url)));
const TO = opt('--to'), ONLY = opt('--only') || '';
if (!TO) { console.error('用法: node restore.mjs --to <空目录> [--key <密码文件>] [--only <前缀>] [--from <仓库目录>]'); process.exit(1); }
if (!fs.existsSync(path.join(FROM, 'index.bin'))) { console.error(`${FROM} 里没有 index.bin, 不是备份仓库 (用 --from 指过去)`); process.exit(1); }

async function askPass() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const p = await new Promise(r => rl.question('备份密码: ', r)); rl.close(); return p.trim();
}
const PASS = opt('--key') ? fs.readFileSync(opt('--key'), 'utf8').trim() : await askPass();
const SALT = Buffer.from(fs.readFileSync(path.join(FROM, 'salt.txt'), 'utf8').trim(), 'hex');
const MK = crypto.scryptSync(PASS, SALT, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
const ENC_KEY = MK.subarray(0, 32);
// 格式: "BB1" + 12 字节 IV + 16 字节 GCM 认证标签 + 密文 (gzip 后的明文)
const open = buf => {
  if (buf.subarray(0, 3).toString() !== 'BB1') throw new Error('不是本备份格式');
  const iv = buf.subarray(3, 15), tag = buf.subarray(15, 31);
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv); d.setAuthTag(tag);
  return zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(31)), d.final()]));
};

let index;
try { index = JSON.parse(open(fs.readFileSync(path.join(FROM, 'index.bin')))); }
catch { console.error('密码不对 (或 index.bin 损坏)'); process.exit(1); }

let ok = 0; const bad = [];
for (const [rel, v] of Object.entries(index)) {
  if (!rel.startsWith(ONLY)) continue;
  // 索引里的路径来自备份方; 防一手 ../ 写到目标目录外面
  const dst = path.resolve(TO, ...rel.split('/'));
  if (!dst.startsWith(path.resolve(TO) + path.sep)) { bad.push(`${rel}: 路径越界, 跳过`); continue; }
  try {
    const parts = Array.from({ length: v.n }, (_, i) => fs.readFileSync(path.join(FROM, 'd', v.b.slice(0, 2), `${v.b}.${i}`)));
    const data = open(Buffer.concat(parts));
    if (v.h && crypto.createHash('sha256').update(data).digest('hex') !== v.h) throw new Error('校验不对');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
    if (v.m > 0) fs.utimesSync(dst, new Date(v.m), new Date(v.m));
    ok++;
  } catch (e) { bad.push(`${rel}: ${e.message}`); }
}
console.log(`解出 ${ok} 个, 失败 ${bad.length} 个 → ${TO}`);
if (bad.length) console.log(bad.map(b => '  ' + b).join('\n'));
process.exit(bad.length ? 3 : 0);
