# 00 · v0 范围冻结

**写作日期** 2026-10-06 ｜ **状态** 冻结稿

---

## §零 这份文档是什么

Creative Atlas v0 **不是一个创意管理系统**，是一个能立刻开始采集的 Monster 图鉴数据库。

真正要验证的只有一件事：

> 看到参考 → 10–30 秒录入 → 能分类/搜索 → 能逐渐沉淀成 Monster Design Library。

「已经建成什么」不重要，**「你还愿不愿意继续收集」才重要**。第 8 条开始嫌烦，就停下来修 Capture UX，不进下一阶段。

---

## §一 唯一Collection

v0 只有**一个** Collection：

```
Monster
├── Inbox        status === 'inbox'的筛选视图
├── Catalog      全部条目
└── Detail       点开后的编辑面板
```

### ⚠️ 这是平表 + 三视图，不是目录树

`Inbox / Catalog / Detail` 是**同一张表的三个视图**，不是三层嵌套结构。实现时不要建 `inbox/`、`catalog/`、`detail/` 三条路由，也不要建 `collection → folder → entry` 的层级。

| 名字 | 是什么 | 实现 |
|---|---|---|
| Inbox | 一个筛选条件 | `WHERE status = 'inbox'` |
| Catalog | 不筛选 | 全部条目 |
| Detail | 一个面板 | 点卡片开 drawer，改metadata |

**理由**：一旦做成目录树，加一个`status` 值就意味着要迁移目录；做成筛选条件，加一个 `status` 值只是多一个按钮。v0 的 schema 会变，视图结构不该跟着变。

### 明确不做

- ❌ AI 自动分析、自动打标、自动生成 brief
- ❌ 复杂知识图谱
- ❌ Monster 编辑器（数值、动作帧、招式表）
- ❌ 生产任务管理
- ❌ 素材生成
- ❌ 游戏工程同步
- ❌ Scene / VFX / SFX / 关卡等其它领域
- ❌ 账号与权限（单机自用，一个 PIN 足够）
- ❌ **通用 Collection Framework** —— 先把 Monster 做通。通用化是 100 条数据之后的结论，不是前提。

---

## §二 数据模型

阶段 1 的字段控制在真正会采集的东西上：

```
MonsterEntry {
  id
  name

  // 来源
  sourceUrl?
  sourceTitle?
  sourceGame?

  // 资产（见 §三）
  imagePath
  imageSource: 'paste' | 'file'
  originalName?

  // Creative Atlas
  tags[]
  notes?

  // Monster Design
  bodyType?
  scale?            // tiny / small / medium / large / huge
  movement[]
  combatRole[]
  attackPattern[]

  // 工作状态
  status: 'inbox' | 'reviewed' | 'reference'
  createdAt
  updatedAt
}
```

**强制填写的只有两项**：`imagePath` · 至少一个 `source`（`status` 有缺省值 `inbox`，不算强制）。

其余字段全部允许空 —— **包括 `tags`**。这是关键：**Atlas 首先是采集系统，不是填写 Monster 调查问卷。**

### ⚠️ 2026-10-06 修正：tags 从强制改为可选

原纪律是「tags 必填，至少一个」，理由是「不打标签的条目以后再也找不回来」。**这条被推翻了**：

- 强制 tag 会把「先存下来、标签回头补」变成「**先想好再存**」—— 而后者正是 v0 要消除的摩擦。判定标准是「连续录 20 条不觉得烦」，任何在入口处的强制都会直接踩线。
- 「找不回来」这个理由可以用工具解决，不必用纪律。侧栏有**「未打标」**视图（`untagged` 筛选 + 侧栏计数），欠账摊开在那里补。

判据不变，只是位置变了：**不在入口拦，事后可查**。入口拦 = 每次采集都摩擦；事后可查 = 摩擦集中在真正该补的时候。

`status` 仍然可省（有 `inbox` 缺省），它本来就不构成负担——推进状态是采集之后的独立动作。

### 不在 v0 里的字段

以下概念先存在 `notes` 里，**收完 100 条再决定要不要升格为字段**：

- `behaviorPattern[]`（死后爆炸、会绕后）
- `telegraph[]`（攻击前摇很明显）
- `reactionPattern[]`（被打会缩起来）

这就是 Schema Evolution 的机制：字段从真实数据里长出来，不是提前设计出来。

---

## §三 图片存储裁定

**图片文件走磁盘，DB 只存相对路径。**

```
/data/local.db                    ← 存 imagePath = 'media/m-01x2y3z/0.png'
/data/media/<entryId>/<n>.png     ← 图片本体
```

### 为什么这么定

- ✅ **导出天然完整** —— JSON + media 目录一起打包，图片就带走了
- ✅ **Gallery 加载快** —— 浏览器只拿缩略图，不用从 db 里拉 BLOB
- ✅ **图片可被别的工具直接引用** —— 未来做 Inspiration Board 时能直接用
- ⚠️ **代价**：infra 的备份/恢复/演练要从「单文件 `VACUUM INTO`」改成「db + 目录双份」

这个代价是**一次性的、可预算的**；而 BLOB 方案的代价是**随数据量持续增长的**（Gallery 查询要分页、要单独拉列）。选前者。

### 布局约定

- 一条目一个目录，目录名 = `entryId`
- 目录内按采集顺序编号：`0.png`、`1.png`
- 扩展名保留原图：`0.jpeg`、`0.webp`、`0.gif`
- 原文件名记进 `originalName`（丢了原图就没法找回出处）

---

## §四 Taxonomie（阶段 3 才建）

**不要试图建立「正确的怪物分类学」。**先从真正关心的设计维度出发。

### 五组受控 tag

| 维度 | 示例 |
|---|---|
| Form | humanoid / beast / blob / insect / construct |
| Scale | tiny / small / medium / large / huge |
| Movement | ground / flying / jumping / crawling / teleport |
| Combat | melee / ranged / charger / zoner / summoner |
| Role | fodder / pressure / disruptor / tank / elite / boss |

### 自由 tag

`#cute` `#weird` `#maplestory-like` `#good-silhouette` `#cheap-to-animate` `#interesting-death`

### `#cheap-to-animate` 这类生产性标签最有价值

Atlas 的终局不是百科全书，是**为生产原创怪物提供素材**。「这只便宜好做」比「这是一只飞行虫类」更能指导下一步。

---

## §五 验收标准

| 阶段 | 动作 | 通过判据 |
|---|---|---|
| D0 | Scope Freeze | 这份文档写完，边界不再讨论 |
| D1 | Data Model + Storage | 能建库、能存一条、能读出来 |
| D2 | Capture UI | **连续录 20 条不觉得烦。** 第 8 条开始嫌烦就停下来修 UX |
| D3 | Gallery / Tag / Search | 三个操作够用：浏览、筛标签、搜 |
| D4 | Polish + Import/Export | JSON 能进出，图片随包走，infra 能部署 |
| v0.1 | FREEZE | **停止开发**，开始真实采集 |
| 20 条 | 检查 Capture UX | 录入流程有无摩擦 |
| 50 条 | 检查 Tag Taxonomy | 受控 tag 够不够用 |
| 100 条 | **Schema Review** | 统计高频 tag、从未用的 tag、notes 里反复出现的东西 |

### 未打标的条目怎么收口

tags 不再强制，所以会有欠账。收口方式只有一个：**侧栏「未打标」视图**。

- 采集时不拦，但欠账要**看得见**（侧栏计数常驻，超过 0 时给一个显眼的入口）。
- 补标签在 Detail drawer 里就地做 —— 不该要求用户回 Quick Add 重录一遍。没有这条，欠就永远欠着。
- 真的堆积了（比如超过 20 条未打标），那说明 tag 维度设计有问题，该在 Schema Review 时处理，而不是把强制加回去。

### 100 条后要统计的五件事

1. 哪些 tag 高频？
2. 哪些 tag 从来没用过？（从受控列表里删掉）
3. 哪些东西总写在 `notes` 里？
4. 哪些概念经常一起出现？
5. 我最常用什么方式找怪物？

**只有真实的 100 条数据，才会告诉你数据结构哪里错了。** 不要提前设计。

---

## §六 定位

Creative Atlas **不承担**「帮我设计 Monster」。

只承担：**让我长期、大量、低摩擦地积累 Monster 视觉与设计语言。**

等 Monster Atlas 真有 100～300 条之后，再做 Compare / Pattern / Inspiration Board / AI Analyze / Generate Brief。那时候 AI 才是在一个已经形成个人审美的数据集上工作，而不是对着十几张图片凭空总结。

---

## §七 技术栈与部署

**技术栈照抄 navi**：Next.js 16 · React 19 · TypeScript · Tailwind 4 · Radix · Drizzle + `node:sqlite` · zod · nanoid。

理由不是「省事」，是 **两个服务共用同一套契约**：`ensureSchema` 幂等迁移、`server-only` 分层、PIN 会话门禁、`VACUUM INTO` 备份、`/healthz` 报版本号。这些在 navi 上都验过一遍了。

### 服务契约

| 项 | 值 |
|---|---|
| 仓库 | `/Users/token/pre-research/creative-atlas/` |
| 镜像 | `ghcr.io/4mdosx/creative-atlas` |
| 容器端口 | 5600 |
| NUC 端口 | 5601（避开 navi 的 5500 / 5501 / 443） |
| infra 服务 | `services/atlas/` |
| Tailscale | `svc:atlas` |
| 数据 | `/srv/ownspire/data/atlas/`（db + media） |

### 部署时机

**D0–D3 全程 `npm run dev` 在本机跑**，D4 才接 infra。

理由：v0 的真实验收是**采集手感**，跟容器无关。D0 就接 infra 的话，四天里会有一天半在跟镜像和网络较劲。

### 必须改的 infra 地方

1. `lib/publish.mjs` 的 `bindOverride()` **写死了目标端口 5500** —— atlas 要参数化，否则端口映射会错。
2. `services/atlas/backup-in-container.mjs` 不能只 `VACUUM INTO` —— 要同时 tar `media/` 目录。
3. `restore` / `drill` 同步改成 db + media 双份。

第 1 条是**真会咬人的**：`bindOverride` 里那个 `5500` 是 navi 的容器端口，atlas 是 5600，不改就静默映射错端口。

---

## §八 可沉淀

- 「平表 + 视图」比「目录树 + 层级」更适合 schema 会变的采集系统
- 图片走磁盘、DB 存相对路径，导出时天然完整
- 生产性标签（`cheap-to-animate`）比分类学标签更能指导生产
- 字段要从数据里长出来，不要提前设计
- 「第 8 条开始嫌烦」是可执行的验收判据，比「用户体验良好」强一百倍
- **强制字段是最贵的一种设计**。「不打标签就找不回来」这类理由该用**视图**解决（未打标筛选），而不是用**纪律**。纪律是每次都付的摩擦，视图是按需付的
- 「只加不删」与「替换」两种语义混在一个函数里，静默失效的概率很高 —— 摘标签这个动作被当成空操作，查了三轮才定位

---

## §九 已知环境限制

**本机 dev server 与 `next build` 可能起不来**，报`EPERM: operation not permitted, rename ...`（turbopack 重建 `.next` 缓存时的 `CURRENT.next → CURRENT`，以及 `server-reference-manifest.json.tmp → ...json`）。

已排除的可能：`com.apple.provenance` 扩展属性（清掉无效）、换 distDir（无效）、`--webpack` 后端（无效）、非沙箱模式（无效）。**与代码无关** —— 同一份代码在本会话早些时候构建成功过（10 个路由全过）。

替代验证手段：service 层是纯函数 + drizzle，可以用 `node --conditions react-server --import tsx` 直接跑，不经过 HTTP。见 `npm run verify:untagged`。