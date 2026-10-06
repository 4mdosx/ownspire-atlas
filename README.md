# Creative Atlas

个人创意采集库。**通用结构，怪物是首个库**（`domain = 'monster'`）—— 「看到参考 → 10–30 秒录入 → 能分类/搜索」这条链路是唯一的验收对象，别的一概不做。

范围与验收标准见 [`docs/00-scope.md`](docs/00-scope.md)。

⚠️ **动这个仓库之前先读 [`AGENTS.md`](AGENTS.md)** —— 里面有删除纪律、本机环境坑、
schema 改动的门禁。这几条都是踩过的。

## 结构

```
entries                顶层条目。name / sourceUrl / imagePath / notes / status / domain
├── monster_entries    怪物专属：招式、行为模式、前摇、受击反应（1:1）
├── tags               名字字典，任意输入，跨 domain 复用
│   └── entry_tags    ⭐ origin 在这里（user / system），不在 tags 上
├── entry_taxonomy     ⭐ 0–1 连续打分，sparse（没打分的维度不存）
└── import_id_map      导入幂等，不进导出包
```

三处刻意的取舍，改动前先读 `docs/00-scope.md`：

| 决定 | 理由 |
|---|---|
| **domain 列表不进数据库** | 现在只有一个 domain。进表是为不存在的第二个 domain 预付设计成本。等它真出现再搬 |
| **taxonomy 维度定义进代码，不进数据库** | 同上。好处是写入侧就能校验「这个维度不属于该 domain」 |
| **origin 挂在 `entry_tags` 上** | `tags` 表里 `cute` 只有一行，但你手动加过、系统也加过 —— origin 挂实体上归属就歧义了 |

**分类标签 vs 度量刻度**：tag 是「是/不是」（`cheap-to-animate`），taxonomy 是「有多」（这条有多便宜好做）。两者互不隶属，混在一起会让用户填两遍。

## 星级映射

界面 1–5 星，数据 0.01 精度。这个矛盾靠交互分档化解：

- **点击星星 → 0.2 步进**（半星可点，6 个可点值）
- **数字框 → 0.01 步进**
- **「没打过分」与「打了 0 分」是两件事** —— 所以 `entry_taxonomy` 是 sparse 表

## 技术栈

与 [navi](../navi) 同一套，两个服务共用同一份服务契约：

- **Next.js 16** + React 19 + TypeScript
- **Tailwind CSS 4** + Radix UI
- **SQLite**（Drizzle ORM + Node `node:sqlite`）
- **zod** 校验 · **nanoid** id

端口 **5600**（navi 占 5500 / 5501 / 443）。

## 本地开发

```bash
npm install
cp .env.example .env
npm run init-db
npm run dev
```

打开 http://localhost:5600 → 首次进入会让你选一个库。

### 验证

```bash
npm run verify
```

40 项断言，覆盖强制校验、未打标逻辑、origin 隔离、taxonomy 星级往返、domain 分流、路径穿越拒绝。

⚠️ 走 service 层直接跑，不经过 HTTP —— 本机dev server 受沙箱限制起不来（见 `docs/00-scope.md` §九），service 层是纯函数 + drizzle，tsx 能直接跑。

### 关于 npm 源

`.npmrc` 里锁了 `registry.npmmirror.com`。原因是本机全局 registry 指向一个**需要 token 的内网镜像**，而官方源在本机网络下 SSL 验证会失败（`curl` 返回 `000`）—— 不显式指定就会卡在重试里（实测 49 分钟仍未完成）。

用公共镜像不需要任何凭据，克隆到别的机器上也能直接 `npm install`。

## 数据放在哪

```
local.db              条目与标签。imagePath 存相对路径
media/<entryId>/      图片本体，一条目一目录
```

**图片走磁盘，DB 只存相对路径。** 这样导出时 JSON + media 目录一起打包就完整了，浏览器也不用从 db 里拉 BLOB。

清库重来（⚠️ 无 undo）：

```bash
npm run reset-db -- RESET
```

## 目录结构

```
app/
  api/atlas/        条目 / 标签 / 图片 / 导入导出
  library/          库工作区（选库、采集、卡片墙、drawer、星级控件）
  healthz/          部署健康检查
backstage/
  db/               schema、幂等迁移、init/reset 脚本
  atlas/            entry / tag / media / export / import 五个 service
types/atlas.ts      共享类型 · domain 常量 · taxonomy 维度定义 · 星级映射
docs/00-scope.md    范围凭据（v0 冻结 → v0.2 通用化改写，含解冻记录）
media/              图片，不进 git
```

## 部署

通过 [ownspire-infra](../ownspire-infra) 作为第二个服务部署：

```bash
node ownspire.mjs atlas deploy
node ownspire.mjs atlas health
node ownspire.mjs atlas backup
node ownspire.mjs atlas restore <backup> --yes
node ownspire.mjs atlas drill
```

需要 Tailscale 后台创建并批准 `svc:atlas`，并在 `/srv/ownspire/router.json` 里加一条映射。

⚠️ 与 navi 的差异：**备份要同时带 db 与 `media/` 目录**，`VACUUM INTO` 单文件不够用。

## 导出格式

`formatVersion: 2`。相对 v0.1：每条自带 `domain`、新增 `taxonomy` 与 `extension`、tag 从 `string[]` 变成 `{name, origin, ruleId}`、`imagePath` 可空。v0.1 的包导入会明确报错，不猜。