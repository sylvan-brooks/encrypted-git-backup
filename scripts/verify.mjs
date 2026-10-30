#!/usr/bin/env node
// verify: 抽查加密备份能不能真的解回来. 备份没真解过一次, 就不能算有备份.
// 加密层本身带校验 (GCM 认证标签 + 明文 sha256), 这里补的是「定期真解一遍」:
// 用 restore.mjs 把一个源 (或其中一部分) 解到临时目录 → 和源文件逐个比 sha256 → 删临时目录.
// 只比上次备份之后没改过的文件 (改过的本来就该不一样).
// 用法: node verify.mjs [--config <配置文件>] [--only <源名/前缀, 默认第一个源>]
// 退出码: 0 全部一致 / 1 环境问题 / 2 有文件解不开或不一致
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const CONFIG = path.resolve(opt('--config') || path.join(HERE, '..', 'backup.config.json'));
if (!fs.existsSync(CONFIG)) { console.error('找不到配置 ' + CONFIG); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const abs = p => path.resolve(path.dirname(CONFIG), p.replace(/^~(?=$|[\\/])/, os.homedir()));
const WORK = abs(cfg.work || './backup-work'), CLOUD = path.join(WORK, 'cloud'), STATE = path.join(WORK, 'state.json');
const KEY = abs(cfg.keyFile || '~/.encrypted-git-backup.key');
let ONLY = opt('--only') || cfg.sources?.[0]?.name || '';
if (ONLY && !ONLY.includes('/')) ONLY += '/';
const srcOf = ONLY.split('/')[0], src = cfg.sources?.find(s => s.name === srcOf);
if (!src) { console.error(`配置里没有叫 ${srcOf} 的源`); process.exit(1); }
const SRC = abs(src.path);
const TMP = path.join(os.tmpdir(), 'egb-verify-' + Date.now());
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

for (const p of [CLOUD, STATE, KEY, SRC]) if (!fs.existsSync(p)) { console.error('缺 ' + p); process.exit(1); }
const state = JSON.parse(fs.readFileSync(STATE, 'utf8')).files;
let code = 0;
try {
  const r = spawnSync(process.execPath, [path.join(CLOUD, 'restore.mjs'), '--to', TMP, '--key', KEY, '--only', ONLY],
    { encoding: 'utf8', timeout: 30 * 60000 });
  if (r.status !== 0) { console.error(`restore 退出 ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`); code = 2; throw 0; }
  let same = 0, skipped = 0; const bad = [];
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith(ONLY)) continue;
    const rel = k.slice(srcOf.length + 1), from = path.join(SRC, ...rel.split('/')), got = path.join(TMP, ...k.split('/'));
    let st; try { st = fs.statSync(from); } catch { skipped++; continue; }   // 源已删, 不算
    if (Math.floor(st.mtimeMs) !== v.mtime) { skipped++; continue; }          // 备份后又改过
    if (!fs.existsSync(got)) { bad.push(rel + ' 没解出来'); continue; }
    if (sha(got) !== sha(from)) bad.push(rel + ' 内容不一致'); else same++;
  }
  console.log(bad.length ? bad.join('\n') : `一致 ${same} 个, 跳过 ${skipped} 个 (备份后改过或已删)`);
  code = bad.length || !same ? 2 : 0;
} catch (e) { if (e !== 0) { console.error('出错: ' + (e.message || e)); code = 1; } }
// process.exit 会跳过 finally, 所以先删临时目录再退出
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(code);
