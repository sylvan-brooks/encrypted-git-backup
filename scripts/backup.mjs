#!/usr/bin/env node
// backup: 把指定的几个目录做两层备份.
//   第 1 层 (可关) 本地镜像: <work>/mirror/ 原样复制, 放在另一块盘上防硬盘坏.
//   第 2 层 加密仓库: <work>/cloud/ 是 git 仓库, 每个文件 gzip → AES-256-GCM 加密, 文件名换成 HMAC 散列,
//          推到 GitHub 私有仓库. 仓库里只有乱码和一个加密索引, 没有密码看不到内容, 也看不到文件名和目录结构.
// 密码: 配置里 keyFile 指的文件 (只在本机, 不进任何备份). 丢了密码 = 加密备份作废, 另存一份到密码管理器或手机.
// 恢复: git clone 仓库 → node restore.mjs --to <空目录>. 只依赖 Node 自带模块.
// 安全阀: ① 源文件数比上次少 30% 以上就整次中止, 什么都不删 (防误删源目录后, 下一次备份把备份也同步删掉).
//         ② 扫描有任何错误 (目录读不了 / 源不存在 / 快照失败) 就本次一个都不删, 没扫到的旧备份原样留着.
// 用法: node backup.mjs [--config <配置文件>] [--no-push] [--init-key]
// 退出码: 0 成功 / 1 参数或环境问题 / 2 推送失败 (本地两层已完成) / 3 安全阀触发, 或本地不完整 (扫描有错, 或有文件复制/读取失败, 下次重试)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const CONFIG = path.resolve(opt('--config') || path.join(HERE, '..', 'backup.config.json'));
if (!fs.existsSync(CONFIG)) { console.error(`[backup] 找不到配置 ${CONFIG}, 照 backup.config.example.json 写一份`); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
// 配置里的相对路径按配置文件所在目录算; ~ 开头换成用户目录
const abs = p => path.resolve(path.dirname(CONFIG), p.replace(/^~(?=$|[\\/])/, os.homedir()));

const WORK = abs(cfg.work || './backup-work');
const MIRROR = cfg.mirror === false ? null : path.join(WORK, 'mirror');
const CLOUD = path.join(WORK, 'cloud');
const STATE = path.join(WORK, 'state.json');
const SNAP = path.join(WORK, '_snap');   // sqlite 快照和联接清单的落地处, 当作普通源进备份
const KEYFILE = abs(cfg.keyFile || '~/.encrypted-git-backup.key');
const LOG = path.join(WORK, 'backup.log');
const PROXY = cfg.proxy || '';
const PART = (cfg.partMB || 90) * 1024 * 1024;  // GitHub 单文件上限 100MB, 留余量
const SQUASH_AT = cfg.squashAt ?? 7;            // 仓库历史超过这么多次提交就压成 1 次, 不会越堆越大; 0 = 不压
const stamp = new Date().toLocaleString('sv-SE').slice(0, 16);
fs.mkdirSync(WORK, { recursive: true });
const log = s => fs.appendFileSync(LOG, `[${stamp}] ${s}\n`);
const die = (code, s) => { log('失败: ' + s); console.error('[backup] ' + s); process.exit(code); };

// ---------- 过滤规则 ----------
// 写法跟 .gitignore 差不多: 不带 / 的规则匹配任意一层的名字 (如 node_modules、*.pyc); 带 / 的从源目录根算 (如 profiles/**).
// include 不写 = 全要; exclude 在 include 之后生效. defaultExclude 可以在配置里改写.
const DEFAULT_EXCLUDE = cfg.defaultExclude ?? ['node_modules', '__pycache__', '.venv', 'Cache', 'GPUCache', 'Code Cache', '*.pyc'];
const segRe = s => new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$', 'i');
const fullRe = g => new RegExp('^' + g.split('/').map(s => s === '**' ? '\u0000' : s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
  .join('/').replace(/\u0000\//g, '(?:.*/)?').replace(/\/\u0000/g, '(?:/.*)?').replace(/\u0000/g, '.*') + '$', 'i');
function makeFilter(src) {
  const inc = (src.include || []).map(g => ({ g, slash: g.includes('/'), re: g.includes('/') ? fullRe(g) : segRe(g), segs: g.split('/') }));
  const exc = [...DEFAULT_EXCLUDE, ...(src.exclude || [])].map(g => ({ slash: g.includes('/'), re: g.includes('/') ? fullRe(g) : segRe(g) }));
  const excluded = rel => { const parts = rel.split('/'); return exc.some(e => e.slash ? (e.re.test(rel) || parts.some((_, i) => e.re.test(parts.slice(0, i + 1).join('/')))) : parts.some(p => e.re.test(p))); };
  return {
    file: rel => !excluded(rel) && (!inc.length || inc.some(i => i.slash ? i.re.test(rel) : i.re.test(rel.split('/').pop()))),
    // 目录值不值得进: 被排除的不进; 有 include 时只进可能装着匹配文件的目录, 免得不相干的目录读不了也算扫描错误
    dir: rel => {
      if (excluded(rel)) return false;
      if (!inc.length) return true;
      const d = rel.split('/');
      return inc.some(i => {
        if (!i.slash) return true;
        for (let k = 0; k < d.length; k++) {
          const s = i.segs[k];
          if (s === undefined) return false;
          if (s === '**') return true;
          if (!segRe(s).test(d[k])) return false;
        }
        return i.segs.length > d.length;
      });
    },
  };
}
const SOURCES = (cfg.sources || []).map(s => ({ src: abs(s.path), name: s.name, f: makeFilter(s) }));
if (!SOURCES.length) die(1, '配置里 sources 是空的');
for (const s of SOURCES) if (!s.name || /[\\/]/.test(s.name)) die(1, `源 ${s.src} 的 name 不能为空, 也不能带斜杠`);
// 一致性快照: { path: 源库, into: 放进哪个源名下 }. 快照是 VACUUM INTO 出来的单文件, 恢复时直接放回原处, 不需要 -wal / -shm.
const SNAP_DBS = (cfg.sqlite || []).map(s => ({ src: abs(s.path), into: s.into || '_sqlite', file: path.basename(s.path) }));

const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', timeout: 20 * 60000, maxBuffer: 64 * 1024 * 1024, ...o });
const git = (...a) => sh('git', ['-C', CLOUD, '-c', 'core.autocrlf=false', ...a]);

// ---------- 密码 ----------
if (args.includes('--init-key')) {
  if (fs.existsSync(KEYFILE)) die(1, `密码文件 ${KEYFILE} 已存在, 不覆盖 (覆盖 = 旧备份全部打不开)`);
  // 6 组 × 5 位, 去掉易混的 0/O/1/I/L, 方便抄写
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pass = Array.from({ length: 6 }, () => Array.from(crypto.randomBytes(5), b => A[b % A.length]).join('')).join('-');
  fs.mkdirSync(path.dirname(KEYFILE), { recursive: true });
  fs.writeFileSync(KEYFILE, pass + '\n', { mode: 0o600 });
  console.log(`已生成 ${KEYFILE} (内容不打印). 自己打开它, 把密码另存一份到密码管理器或手机.`);
  process.exit(0);
}
if (!fs.existsSync(KEYFILE)) die(1, `没有密码文件 ${KEYFILE}, 先跑 --init-key`);
const PASS = fs.readFileSync(KEYFILE, 'utf8').trim();
fs.mkdirSync(CLOUD, { recursive: true });
const saltFile = path.join(CLOUD, 'salt.txt');
if (!fs.existsSync(saltFile)) fs.writeFileSync(saltFile, crypto.randomBytes(16).toString('hex') + '\n');
const SALT = Buffer.from(fs.readFileSync(saltFile, 'utf8').trim(), 'hex');
const MK = crypto.scryptSync(PASS, SALT, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
const ENC_KEY = MK.subarray(0, 32), NAME_KEY = MK.subarray(32);
const seal = buf => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(buf, { level: 6 })), c.final()]);
  return Buffer.concat([Buffer.from('BB1'), iv, c.getAuthTag(), body]);
};
const blobName = s => crypto.createHmac('sha256', NAME_KEY).update(s).digest('hex').slice(0, 40);
// ---------- 扫源 ----------
// 所有扫描错误都进 scanErr: 读不了的目录如果直接跳过, 那些文件会从清单里消失, 后面被当成"删了"把备份也删掉.
const scanErr = [];
const junctions = [];    // 目录联接 / 符号链接: { link, target }, 写进 _meta/junctions.json, 恢复时照着重建
function walk(dir, f, name, base = dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { scanErr.push(`目录读不了 ${name}/${path.relative(base, dir).replace(/\\/g, '/') || '.'}: ${e.code || e.message}`); return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name), rel = path.relative(base, p).replace(/\\/g, '/');
    // 链接不跟进去 (跟进去会重复备份, 还可能绕圈); 能解析出目标的记下来. 解析不了的 (socket 之类) 跳过, 不算错.
    if (e.isSymbolicLink()) { try { junctions.push({ link: p, target: fs.realpathSync(p) }); } catch {} continue; }
    if (e.isDirectory()) { if (f.dir(rel)) walk(p, f, name, base, out); }
    else if (e.isFile() && f.file(rel)) {
      try { const s = fs.statSync(p); out.push({ p, rel, size: s.size, mtime: Math.floor(s.mtimeMs) }); }
      catch (x) { scanErr.push(`读不到文件信息 ${name}/${rel}: ${x.code || x.message}`); }
    }
  }
  return out;
}
const files = [];
const scan = list => {
  for (const s of list) {
    if (!fs.existsSync(s.src)) { scanErr.push(`源不存在: ${s.src}`); continue; }
    for (const x of walk(s.src, s.f, s.name)) files.push({ ...x, key: s.name + '/' + x.rel });
  }
};
scan(SOURCES);

// ---------- sqlite 一致性快照 ----------
// 正在被程序写的 sqlite 直接复制, 主文件和 -wal 可能对不上. VACUUM INTO 在一个读事务里导出某一时刻完整的单文件库.
// 先写 .tmp 再改名, 中途失败不会留半截; 内容没变时快照字节一样, 只在 sha 变了才替换, 免得每天重传.
const snapSources = [];
if (SNAP_DBS.length) {
  const ew = process.emitWarning;   // node:sqlite 在部分版本会打 ExperimentalWarning, 定时任务里只当噪音
  process.emitWarning = (w, ...a) => ((typeof a[0] === 'string' ? a[0] : a[0]?.type) === 'ExperimentalWarning' ? undefined : ew.call(process, w, ...a));
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (e) { scanErr.push(`这个 Node 没有 node:sqlite (要 22.5+), 快照跳过: ${e.message}`); }
  const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  for (const d of SNAP_DBS) {
    const dir = path.join(SNAP, 'sqlite', d.into);
    fs.mkdirSync(dir, { recursive: true });
    if (!snapSources.some(s => s.name === d.into)) snapSources.push({ src: dir, name: d.into, f: { file: rel => !rel.endsWith('.tmp'), dir: () => true } });
    if (!DatabaseSync) continue;
    // 某个库这次快照失败, 上次的快照还在, 照常备份那份旧的; 同时算扫描出错, 本次退出 3
    const dst = path.join(dir, d.file), tmp = dst + '.tmp';
    if (!fs.existsSync(d.src)) { scanErr.push(`sqlite 库不存在: ${d.src}`); continue; }
    try {
      fs.rmSync(tmp, { force: true });
      const db = new DatabaseSync(d.src, { readOnly: true });
      try { db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { db.close(); }
      if (fs.existsSync(dst) && sha(dst) === sha(tmp)) fs.rmSync(tmp);
      else fs.renameSync(tmp, dst);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      scanErr.push(`sqlite 快照失败 ${d.file}: ${e.code || e.message}`);
    }
  }
}
// ---------- 联接清单 (内容不变就不重写) ----------
{
  const dir = path.join(SNAP, 'meta'), p = path.join(dir, 'junctions.json');
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ note: '恢复时把目标目录先放回原位, 再逐条重建链接 (Windows: mklink /J "<link>" "<target>"; 其它系统: ln -s)', junctions }, null, 2) + '\n';
  if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== body) fs.writeFileSync(p, body);
  snapSources.push({ src: dir, name: '_meta', f: { file: rel => !rel.endsWith('.tmp'), dir: () => true } });
}
scan(snapSources);
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { files: {} };
const prevN = Object.keys(state.files).length;
if (prevN && files.length < prevN * 0.7)
  die(3, `安全阀: 源文件 ${files.length} 个, 上次 ${prevN} 个, 少了 30% 以上. 先核对是不是误删了东西; 确认没问题就删掉 ${STATE} 再跑`);
for (const s of scanErr.slice(0, 20)) log('扫描出错: ' + s);
if (scanErr.length > 20) log(`扫描出错: ……另有 ${scanErr.length - 20} 条`);

// ---------- 第 1 层镜像 + 第 2 层加密 ----------
let mCopy = 0, mDel = 0, cPut = 0, cDel = 0, fail = 0;
const now = {};
const retire = []; // 新索引写好之后才删的旧密文块: [块名, 分片数]
for (const f of files) {
  const old = state.files[f.key];
  now[f.key] = { size: f.size, mtime: f.mtime, blob: old?.blob, parts: old?.parts, sha: old?.sha };
  if (old && old.size === f.size && old.mtime === f.mtime) continue;   // 大小和修改时间都没变, 跳过
  if (MIRROR) {
    const dst = path.join(MIRROR, f.key);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // git 对象之类的只读文件, 复制出来也带只读属性, 第二次覆盖会 EPERM → 覆盖前先去掉只读.
    // 先复制成临时文件再改名: 复制到一半断电, 镜像里也不会留下半截文件.
    try {
      try { if (!(fs.statSync(dst).mode & 0o200)) fs.chmodSync(dst, 0o666); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fs.copyFileSync(f.p, dst + '.bbtmp'); fs.renameSync(dst + '.bbtmp', dst); mCopy++;
    } catch (e) { fs.rmSync(dst + '.bbtmp', { force: true }); log(`镜像复制失败 ${f.key}: ${e.code || e.message}`); now[f.key].dirty = true; fail++; continue; }
  }
  let data; try { data = fs.readFileSync(f.p); } catch (e) { log(`读取失败 ${f.key}: ${e.code}`); now[f.key].dirty = true; fail++; continue; }
  // 块名带内容散列: 新块写完 → 索引换好 → 最后才删旧块 (见 retire). 中途断电, 旧版本还在, 索引也还指着它.
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const b = blobName(f.key + '\0' + sha);
  if (old?.blob === b) { Object.assign(now[f.key], { blob: b, parts: old.parts, sha }); continue; }   // 内容没变, 只是改了时间
  const enc = seal(data), n = Math.max(1, Math.ceil(enc.length / PART));
  fs.mkdirSync(path.join(CLOUD, 'd', b.slice(0, 2)), { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(CLOUD, 'd', b.slice(0, 2), `${b}.${i}`), enc.subarray(i * PART, (i + 1) * PART));
  if (old?.blob) retire.push([old.blob, old.parts || 0]);
  Object.assign(now[f.key], { blob: b, parts: n, sha }); cPut++;
}
// ---------- 删除: 上次有、这次没有的 ----------
// 扫描有错时, "这次没有"可能只是没读到, 不能当成删了 → 一个都不删, 旧条目原样带进 now, 索引和密文仍对得上.
let kept = 0;
for (const [key, old] of Object.entries(state.files)) {
  if (now[key]) continue;
  if (scanErr.length) { now[key] = old; kept++; continue; }
  if (MIRROR) { fs.rmSync(path.join(MIRROR, key), { force: true }); mDel++; }
  if (old.blob) retire.push([old.blob, old.parts || 0]);
  cDel++;
}
for (const v of Object.values(now)) if (v.dirty) { delete v.dirty; v.mtime = -1; } // 下次重试
// 加密索引: 散列名 → 真实路径. 仓库里只有这一份能对上名字, 它也是加密的. 临时文件 + 改名, 不会写出半截.
const index = Object.fromEntries(Object.entries(now).filter(([, v]) => v.blob).map(([k, v]) => [k, { b: v.blob, n: v.parts, s: v.size, m: v.mtime, h: v.sha }]));
const putAtomic = (p, buf) => { fs.writeFileSync(p + '.tmp', buf); fs.renameSync(p + '.tmp', p); };
putAtomic(path.join(CLOUD, 'index.bin'), seal(Buffer.from(JSON.stringify(index))));
putAtomic(STATE, JSON.stringify({ at: stamp, files: now }));
// 索引已经指向新块, 现在删旧块才安全. 还在被索引用的块不删 (保险)
{
  const live = new Set(Object.values(now).map(v => v.blob).filter(Boolean));
  for (const [b, n] of retire) {
    if (live.has(b)) continue;
    for (let i = 0; i < n; i++) fs.rmSync(path.join(CLOUD, 'd', b.slice(0, 2), `${b}.${i}`), { force: true });
  }
}
const counts = `源 ${files.length} 个, ${MIRROR ? `镜像复制 ${mCopy} 删 ${mDel}, ` : ''}加密写 ${cPut} 删 ${cDel}`;
const bad = scanErr.length || fail;   // 不完整: 推送照常做, 但最后退出 3
if (bad) {
  const msg = `本地不完整: 扫描出错 ${scanErr.length} 处, 复制/读取失败 ${fail} 个 (下次重试)${kept ? `, 因扫描出错本次不删, 保留 ${kept} 个没扫到的旧备份` : ''}; ${counts}`;
  log(msg); console.error('[backup] ' + msg);
} else log(`本地 ok: ${counts}`);
const done = s => { log(s); console.log(s); process.exit(bad ? 3 : 0); };

// ---------- 仓库: 恢复脚本 + 说明 (明文, 不含任何备份内容) ----------
fs.copyFileSync(path.join(HERE, 'restore.mjs'), path.join(CLOUD, 'restore.mjs'));
fs.writeFileSync(path.join(CLOUD, '.gitattributes'), '* -text\n');
fs.writeFileSync(path.join(CLOUD, 'README.md'), `# 加密备份

这里只有加密后的乱码, 没有密码打不开, 文件名也是散列.
恢复: 装 Git 和 Node.js 18+ → \`git clone <本仓库>\` → \`node restore.mjs --to <空目录>\` → 输入密码.
`);
const ID = ['-c', 'user.name=encrypted-git-backup', '-c', 'user.email=backup@localhost'];
if (!fs.existsSync(path.join(CLOUD, '.git'))) git('init', '-q', '-b', 'main');
git('add', '-A');
if (git('status', '--porcelain').stdout.trim()) {
  const r = git(...ID, 'commit', '-q', '-m', `备份 ${stamp}`);
  if (r.status !== 0) die(3, '提交失败: ' + (r.stderr || r.stdout).slice(0, 300));
}
// 历史太长就压成一次提交. 这个仓库是"最新一份的加密快照", 不靠它留历史; 要历史, 把源目录本身做成 git 仓库一起备份.
const nCommits = Number(git('rev-list', '--count', 'HEAD').stdout.trim() || 0);
let squashed = false;
if (SQUASH_AT > 0 && nCommits > SQUASH_AT) {
  git('checkout', '-q', '--orphan', 'squash');
  git(...ID, 'commit', '-q', '-m', `备份 ${stamp} (历史已压缩)`);
  git('branch', '-D', 'main'); git('branch', '-m', 'main');
  squashed = true;
}
// 压缩后的旧对象: 推送成功以后再清 (先清会让推送把全部文件重传一遍)
const tidy = () => { if (squashed) { git('reflog', 'expire', '--expire=now', '--all'); git('gc', '-q', '--prune=now'); } };
if (args.includes('--no-push')) { tidy(); done('跳过推送 (--no-push)'); }
if (!git('remote').stdout.includes('origin')) { tidy(); done(`没配远程仓库, 只做了本地. 配好后: git -C "${CLOUD}" remote add origin <私有仓库地址>`); }
const push = git(...(PROXY ? ['-c', `http.proxy=${PROXY}`] : []), '-c', 'http.postBuffer=524288000', 'push', '-q', ...(squashed ? ['--force'] : []), 'origin', 'main');
if (push.status !== 0) die(2, '推送失败 (本地已完成): ' + (push.stderr || '').replace(/\s+/g, ' ').slice(0, 300));
tidy();
done(`推送 ok${squashed ? ' (压缩历史后强推)' : ''}`);
