# encrypted-git-backup：把电脑上的重要文件加密备份到 GitHub 私有仓库

把指定的几个文件夹加密后推到 GitHub 私有仓库。仓库里只有乱码：看不到内容，也看不到文件名和目录结构。换了新电脑，`git clone` 下来输入密码就能解回原样。

Encrypt chosen folders (AES-256-GCM, hashed file names, encrypted index) and push them to a private Git repo; restore anywhere with plain Node.js.

## 为什么做这个

我想要的是：电脑硬盘坏了、系统重装了，新电脑上能把笔记、配置、脚本原样找回来，接着用。

现成的路有两条，都不太合适：

- 直接推到 GitHub 私有仓库：方便，但明文交给了平台。私有仓库也只是"别人看不到"，平台自己、将来的泄露、误操作改成公开，都会让内容裸奔。
- 用 restic / borg 这类专业备份工具：很成熟，但要装额外的程序，还要找个它支持的存储后端。

所以就写了这个：只用 Node 自带模块，存储就是一个普通 git 仓库，加密在本机做完再推出去。

## 能做什么

| 脚本 | 作用 |
|---|---|
| `scripts/backup.mjs` | 按配置扫源目录 → 本地镜像一份（可关）→ 每个文件单独加密 → 提交并推到远程仓库 |
| `scripts/restore.mjs` | 把加密仓库解回明文。备份时会自动复制一份到仓库根目录，clone 下来就能直接用 |
| `scripts/verify.mjs` | 抽查：真的解一遍，和源文件逐个比 sha256。建议每周跑一次 |

几个细节：

- **两层**：第 1 层是本地原样镜像，建议放在另一块硬盘上，防硬盘坏；第 2 层是加密仓库，防整台电脑出事。
- **只传改过的**：大小和修改时间都没变的文件跳过；内容没变只是时间变了的，也不重传。
- **大文件自动分片**：GitHub 单文件上限 100MB，加密后超过 90MB 的切成几片。
- **仓库不会越堆越大**：提交超过 7 次就压成 1 次再强推。这个仓库只存"最新一份"。要历史版本，把源目录本身做成 git 仓库，连 `.git` 一起备份。
- **正在写的 sqlite 也能备**：配置里列出的库用 `VACUUM INTO` 做一致性快照再备份，不会拷出半截。
- **目录链接不跟进去**：Windows 的目录联接 / 符号链接只记下"谁指向谁"，写进 `_meta/junctions.json`，恢复时照着重建。

## 用法

需要 Node.js 18+（要备份 sqlite 的话 22.5+）和 Git。

```bash
# 1. 写配置: 复制一份示例改成自己的
cp backup.config.example.json backup.config.json

# 2. 生成密码 (只做一次). 生成后自己打开密码文件, 另存一份到密码管理器或手机
node scripts/backup.mjs --init-key

# 3. 先只做本地, 看看日志对不对
node scripts/backup.mjs --no-push

# 4. 在 GitHub 新建一个空的私有仓库, 接上
git -C <work>/cloud remote add origin git@github.com:<你>/<仓库>.git
node scripts/backup.mjs
```

然后把第 4 步那条命令放进计划任务（Windows 任务计划程序 / macOS launchd / Linux cron），每天跑一次。

恢复：

```bash
git clone git@github.com:<你>/<仓库>.git
node <仓库>/restore.mjs --to ./恢复出来的        # 会问密码
node <仓库>/restore.mjs --to ./只要笔记 --only notes/   # 只恢复一个源
```

### 配置

```json
{
  "work": "D:/backup-work",
  "keyFile": "~/.encrypted-git-backup.key",
  "mirror": true,
  "proxy": "",
  "sources": [
    { "path": "D:/Notes", "name": "notes" },
    { "path": "~/.config/myapp", "name": "myapp-config", "include": ["*.json", "*.toml", "profiles/**"] },
    { "path": "D:/Projects", "name": "projects", "exclude": ["dist", "*.log"] }
  ],
  "sqlite": [
    { "path": "~/.myapp/state.sqlite", "into": "myapp-db" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `work` | 工作目录：镜像、加密仓库、状态文件、日志都在这里。建议放在另一块硬盘上 |
| `keyFile` | 密码文件。**不要放进任何被备份的目录** |
| `mirror` | `false` 就不做本地镜像，只做加密仓库 |
| `proxy` | 推送时用的 HTTP 代理，不需要就留空 |
| `sources[].name` | 这个源在备份里的名字，恢复出来就是这个文件夹名 |
| `include` / `exclude` | 写法跟 `.gitignore` 差不多：不带 `/` 的匹配任意一层的名字（`node_modules`、`*.pyc`），带 `/` 的从源目录根算（`profiles/**`）。`include` 不写就是全要 |
| `defaultExclude` | 默认排除 `node_modules`、`__pycache__`、`.venv`、浏览器缓存目录和 `*.pyc`，可以改写 |
| `sqlite` | 要做一致性快照的库；快照放在 `into` 这个名字下面 |
| `partMB` / `squashAt` | 分片大小（默认 90）和压缩历史的阈值（默认 7，`0` 不压） |

退出码：`0` 成功 / `1` 参数或环境问题 / `2` 推送失败（本地已完成）/ `3` 安全阀触发或本地不完整。计划任务里按退出码发通知就行。

## 安全阀

备份工具最怕的是"源目录被误删了，半夜备份照着同步，把备份也删光"。所以：

1. 源文件数比上次少了 30% 以上，整次中止，什么都不动。
2. 扫描时有任何错误（目录读不了、源不存在、快照失败），本次一个都不删。读不到不等于删了。
3. 镜像先复制成临时文件再改名；密文块名带内容散列，新块写好、索引换好之后才删旧块。中途断电，旧版本还在，索引也还指着它。

## 怎么做的

- 密码用 scrypt（N=2¹⁵, r=8, p=1）配一个随机盐派生出 64 字节：前 32 字节是加密密钥，后 32 字节是文件名密钥。盐存在仓库里，不是秘密。
- 每个文件先 gzip，再用 AES-256-GCM 加密，每次随机 12 字节 IV。格式是 `BB1` + IV + 16 字节认证标签 + 密文。GCM 的认证标签保证密文被改过一个字节就解不开，恢复时还会再核一遍明文的 sha256。
- 密文的文件名是 `HMAC(文件名密钥, 路径 + 内容散列)` 取前 40 位。没有密码，从名字上看不出是哪个文件，也看不出两个块是不是同一个文件的新旧版本。
- 真实路径和密文块的对应关系写在 `index.bin` 里，这个索引本身也是加密的。

## 局限，用之前要知道

- **密码丢了，备份就没了。** 没有找回机制，也没有后门。
- 平台看不到内容和文件名，但看得到：大概有多少个文件、每个块多大、每天什么时候备份。
- 没有块级去重：大文件改了一个字节，整个文件重新加密上传。适合笔记、配置、脚本、文档，不适合几十 GB 的照片视频库。GitHub 建议单个仓库别超过几 GB。
- 不支持换密码。要换只能用新密码重新做一个仓库。
- 本地的 `state.json` 和镜像是明文，别把 `work` 目录放在会同步到网盘的地方。
- 只存最新一份，不是版本库。

## 给 AI 用

仓库根目录有 `SKILL.md`，放进 Claude Code 的 `~/.claude/skills/encrypted-git-backup/` 或 Codex 的 skills 目录，说「帮我把这几个文件夹加密备份到 GitHub」「从备份里恢复」就会照着做：问清要备份什么、写配置、提醒你存密码、配计划任务。这个 skill 交给 AI 用效果更好，直接丢给 AI 就可以了。

## 许可

MIT
