# 00 ·范围（v0 冻结 → v0.2 通用化改写）

**写作日期** 2026-10-06 ｜ **状态** v0 冻结稿
**改写日期** 2026-10-06 ｜ **状态** v0.2 通用化（§一 / §二 / §四 已改写，见下方改写记录）

---

## §零 这份文档是什么

Creative Atlas **不是一个创意管理系统**，是一个能立刻开始采集的 **通用创意参考库**。

真正要验证的只有一件事：

> 看到参考 → 10–30 秒录入 → 能分类/搜索 → 能逐渐沉淀成某个领域的 Design Library。

「已经建成什么」不重要，**「你还愿不愿意继续收集」才重要**。第 8 条开始嫌烦，就停下来修 Capture UX，不进下一阶段。

### 2026-10-06 · v0.2 通用化改写记录

**这次解冻了两个决定：**

| 项 | 原 v0 冻结稿 | 现行|
|---|---|---|
| 顶层结构 | 只有 `MonsterEntry` 一张表 | `entries`（通用）+ `monster_entries`（domain 扩展） |
| 定位 | Monster 图鉴数据库 | 通用创意工具，Monster 是首个 domain |

**为什么提前推翻「通用化是 100 条之后的结论」：**

原判断本身没错 —— 它假设「第二个 domain 什么时候出现」是不可知的，所以要用数据倒逼。**但这个假设被一个更硬的事实否掉了**：v0.1 交付时数据库仍是 0 条数据，而 schema 冻结在代码里。**每次录一条都在加深「字段长在Monster 上」的结构性假设。**

0 条数据是迁移成本为零的唯一窗口（无数据迁移、无 id 重映射、无 `media/` 目录改名）。等到有数据再改，三件事要一起动。

**这次改动的实际依据：**

- 「属于什么项目背后通过 tag 实现」要求 tag 跨domain 复用 → tags不能挂在 domain 上
- 「后续不同的采集都存储成 entries」要求 `name` / `sourceUrl` / `imagePath` 提到顶层 → 否则每加一个 domain 就复制一遍这三列
- Catalog 跨类型免 JOIN 的收益，在entries 层就能拿到，**不需要 domain 列表进表**

**保留不动的纪律（仍然成立）：**

- 平表 + 视图，不是目录树 —— 这条没被打破，只是「表」从1 张变成 1 + N（N 是 domain 扩展表数量）
- 强制字段尽量少 —— 见下，通用化后强制字段从 2 项变成 1 项
- 图片走磁盘、DB 存相对路径
- 字段从真实数据里长出来 —— **这次改的是「一个条目属于哪个 domain」这个正交维度，不是往条目里塞新字段**

**改写带来的新风险（要盯）：**

多了一层 `entries → domain 扩展表` 的间接查询。这是通用化唯一真实的代价，不免费。验收时看 Catalog 页是否仍流畅。

---

## §一 多Domain 平表 + 视图

v0.2 起，条目是 `entries`，按 `domain` 分流到各自的扩展表：

```
entries                 ← 顶层，所有采集共用
├── domain = 'monster'  → monster_entries（怪物专属结构化数据）
└── domain = <其他>     → <domain>_entries（将来）

Catalog / Inbox / Detail  三个视图仍只查 entries 一张表
```

### ⚠️ 这仍然是平表 + 三视图，不是目录树

`Inbox / Catalog / Detail` 是**同一张表的三个视图**，不是三层嵌套结构。不要建 `inbox/`、`catalog/`、`detail/` 三条路由，也不要建 `entry → folder → entry` 的层级。

| 名字 | 是什么 | 实现 |
|---|---|---|
| Inbox | 一个筛选条件 | `WHERE status = 'inbox'` |
| Catalog | 不筛选 | 全部条目，可按 domain 筛 |
| Detail | 一个面板 | 点卡片开 drawer，改metadata |

**理由**：一旦做成目录树，加一个`status` 值就意味着要迁移目录；做成筛选条件，加一个 `status` 值只是多一个按钮。schema 会变，视图结构不该跟着变。

**domain 列表不进数据库**，暂时留在代码常量里。

理由：现在只有一个 domain。进表的代价是多两张表、多一层 join、顺序和中英文要 seed —— 而「字段从真实数据里长出来」说的就是别为不存在的第二个 domain 付设计成本。**等第二个 domain 真出现、维度真要分叉了再搬进表**，那时候搬是有数据支撑的。

`entries.domain` 这一列本身就足够支撑 Catalog 跨类型查询，通用化的核心收益不需要 `domains` 表。

### 明确不做

- ❌ AI 自动分析、自动生成 brief
- ❌ 复杂知识图谱
- ❌ 数值/动作帧编辑器（怪物招式等结构化数据只做记录，不做调参工具）
- ❌ 生产任务管理
- ❌ 素材生成
- ❌ 游戏工程同步
- ❌ 账号与权限（单机自用，一个 PIN 足够）
- ❌ **domain 列表管理界面** —— 加domain 是改代码，不是点按钮。理由同「维度定义不进表」：只有一个 domain 时，通用化框架的唯一使用者是自己。

---

## §二 数据模型

### 顶层：`entries` —— 所有 domain 共用

```
Entry {
  id
  domain              // 'monster' · ...
  name
  status: 'inbox' | 'reviewed' | 'reference'

  // 来源
  sourceUrl?
  sourceTitle?
  sourceGame?

  // 资产（见 §三）
  imagePath?
  imageSource: 'paste' | 'file'
  originalName?

  notes?
  createdAt
  updatedAt
}
```

### 扩展表：`monster_entries` —— 怪物专属

**只有 taxonomy 表达不了的结构化数据才放这里。** 1:1，外键指向 `entries.id`。

```
MonsterExtension {
  entryId              // PK → entries.id
  attackPattern[]      // 招式：结构化，有先后关系
  behaviorPattern[]    // 行为模式（死后爆炸、会绕后…）
  telegraph[]          // 前摇特征
  reactionPattern[]    // 受击反应
}
```

**已从这层裁掉的字段**：`bodyType` / `scale` / `movement` / `combatRole` / `attackPattern`（离散版）。

理由：这些和 §四 的 taxonomy 维度重复 —— 旧版是离散枚举（humanoid / tiny / melee），新版是 0–1 连续打分。留两套就是让用户填两遍，而且两遍可能不一致。**taxonomy 接管这五项，这层只留 taxonomy 表达不了的结构。**

那四个 `*Pattern` 字段原本在 §二 里写着「先存在 notes 里」，现在提到扩展表 —— 它们从 100 条后才考虑的对象，变成了 v0.2 的正式字段。

理由：通用化之后，「哪些字段属于 domain 扩展」这个问题必须有个答案，而这些字段是唯一符合「taxonomy 表达不了」的候选。**没有第二个 domain 出现，这个划分的正确性只有理论保证。** 真跑起来后发现字段放错层，改的是加列不是改表。

### 强制填写

**只剩一项：`sourceUrl`。**

`imagePath` 从 NOT NULL 降为可空 —— 通用化后必然有不以图为中心的采集类型，强制图片会挡住它们。代价：monster 这个 domain 的图片入口不再是数据库约束，要靠 UI 提示。

其余字段全部允许空 —— **包括 `tags` 和 `taxonomy`**。

**强制字段是最贵的一种设计**。「不打标签就找不回来」这类理由该用**视图**解决（未打标筛选），而不是用**纪律**。纪律是每次都付的摩擦，视图是按需付的。

### tags 从强制改为可选（2026-10-06 原裁定，v0.2 保留）

强制 tag 会把「先存下来、标签回头补」变成「**先想好再存**」—— 而后者正是要消除的摩擦。判据是「连续录 20 条不觉得烦」，任何在入口处的强制都会直接踩线。

「找不回来」可以用工具解决，不必用纪律。侧栏有「未打标」视图（`untagged` 筛选 + 侧栏计数），欠账摊开在那里补。

判据不变，只是位置变了：**不在入口拦，事后可查**。

---

## §三 图片存储裁定

**图片文件走磁盘，DB 只存相对路径。**

```
/data/local.db← 存 imagePath = 'media/m-01x2y3z/0.png'
/data/media/<entryId>/<n>.png     ← 图片本体
```

目录名 = **顶层 `entries.id`**，不是 `monster_entries.entryId`。两个 id 一致（1:1），但取顶层那个 —— 换domain 时目录不用动。

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

## §四 Tags 与 Taxonomy（两套，互不隶属）

**v0.2 起这两件事彻底分开。** 旧的「受控 taxonomy」其实是个被误放在 tag 体系里的分类学。

### Tags —— 自由标签，系统核心

- **任意输入，没有白名单，没有受控列表**
- 不区分维度，不检查是否属于某个已定义维度
- 一套tag 跨 domain 复用（「飞行」在 monster 和场景里都能用）
- **「属于什么项目」完全通过 tag 表达** —— 这是 tag 系统的核心职责

#### ⭐ origin：区分用户输入与系统自动添加

⚠️ **origin 挂在 `entry_tags` 上，不挂在 `tags` 上。**

理由：tag 表里 `cute` 只有一行，但可能你手动加过、系统也自动加过。origin 挂在 tag 上，那这一行到底算谁的？

```
tags:        id · name UNIQUE · createdAt · updatedAt
             ← 只是名字字典，无 origin

entry_tags:  PK(entryId, tagId)
             origin: 'user' | 'system'
             ruleId?         ← 系统 tag 记来源规则，可整批追溯
             createdAt
```

同一个 tag 在 A 条目是手动加的、B 条目是系统打的，各自独立。

这条同时支撑「一个项目背后通过 tag 实现」：项目相关的 tag 全部 `origin='system'` + `ruleId`，可以按规则整批查、整批改、整批导出。

系统 tag 的候选来源（**都不在v0.2 实现**）：导入包携带的项目标记、未来的 AI 预标、批量规则。「属于什么项目」这条需求本身由这套结构满足，但写入方暂时只有用户。

### Taxonomy —— 连续打分，按 domain 分维度

**与 tag 系统无关。** 它是有结构的度量，不是分类标签。

```
维度定义 → 留在代码常量里（不进数据库）
数值     → 存在 entry_taxonomy
```

**维度按 domain 确定。** monster 有 form / scale / movement / combat / role 五个维度，换 domain 就换一组维度。

**中英文双语**：`labelZh` / `labelEn` 都在维度定义里。

**存 0–1，精确到 0.01；界面是 1–5 星。**

⚠️ 这两者对不上，映射规则先定死，否则后面对不上：

| 操作 | 步进 | 换算 |
|---|---|---|
| 点击星星 | 0.2（半星可点 → 6 个可点值：0 / .2 / .4 / .6 / .8 / 1） | `star = round(score × 5)` |
| 滑杆 / 数字框 | 0.01 | |
| 悬停显示 | 显示原始 `score` | |

**星级是显示编码，不是数据。** 数据库存 `score`，不存星数。

⚠️ **「半星可点」和「11 档」不是一回事**：星数是 5，半星只是让每颗星能落在两个位置，总共仍是 6 个可点值。11 档对应 0.1 步进，那是滑杆的精度。

### 维度列表（monster）

| code | 中文 | English |
|---|---|---|
| `form` | 形态 | Form |
| `scale` | 体量 | Scale |
| `movement` | 移动 | Movement |
| `combat` | 战斗方式 | Combat |
| `role` | 定位 | Role |

旧的离散枚举值（humanoid / tiny / melee…）**不再是数据里的枚举**，只是给打分时的语义参照 —— 5星在这五个维度上大致对应「非常 humanoid」。

### `#cheap-to-animate` 这类生产性标签最有价值

Atlas 的终局不是百科全书，是**为生产原创素材提供参考**。「这只便宜好做」比「这是一只飞行虫类」更能指导下一步 —— 这类判断写在 **tag** 里（`cheap-to-animate`），不是 **taxonomy** 里（taxonomy 是「这条有多便宜好做」的可比较刻度）。两者互补，不是同一件事。

---

## §五 验收标准

| 时点 | 动作 | 通过判据 |
|---|---|---|
| 20 条 | 检查 Capture UX | **录入流程有无摩擦**。含「选 domain」那一步的净开销 |
| 50 条 | 检查 tag 体系 | 任意输入够不够用。有没有产生同义 tag 没合并 |
| 100 条 | **Schema Review** | ①哪些 tag 高频 ② 频率趋近 0 的 tag 该删 ③ 哪些东西反复写在 `notes` 里 ④ 哪些概念总一起出现 ⑤ `monster_entries` 的四个 `*Pattern` 字段放对层了吗 |

### ⚠️ v0.2 新增要盯的三件事

1. **「选 domain」那一步的实际开销** —— 如果它出现在每条录入的路径上，就是摩擦。解法已定：domain 选择器常驻顶栏，不在录入流里；只有首次进入或显式切库才走完整选型。
2. **Catalog 跨类型是否仍流畅** —— 多了一层 `entries → domain 扩展表` 间接查询，这是通用化唯一真实的代价。
3. **tag 体系有没有失控** —— 允许任意输入的代价是同义 tag 会增殖。判据是「有没有产生需要手动合并的重复」，不是「tag 数有没有变多」。

### 未打标的条目怎么收口

tags 不再强制，所以会有欠账。收口方式只有一个：**侧栏「未打标」视图**。

- 采集时不拦，但欠账要**看得见**（侧栏计数常驻，超过 0 时给一个显眼的入口）。
- 补标签在 Detail drawer 里就地做 —— 不该要求用户回Capture 重录一遍。没有这条，欠就永远欠着。
- 真的堆积了（比如超过 20 条未打标），那说明 tag 输入流程有问题，该在Schema Review 时处理，**而不是把强制加回去**。

### 100 条后要统计的五件事

1. 哪些 tag 高频？
2. 哪些 tag 从来没用过？
3. 哪些东西总写在 `notes` 里？
4. 哪些概念经常一起出现？
5. 我最常用什么方式找东西？
6. **taxonomy 打分我实际用了多少？** 全部维度都填，还是只用几个？长期不填的维度该从定义里删掉

**只有真实的 100 条数据，才会告诉你数据结构哪里错了。** 不要提前设计。

---

## §六 定位

Creative Atlas **不承担**「帮你设计 Monster」，也不承担「帮你设计任何东西」。

只承担：**让我长期、大量、低摩擦地积累视觉与设计语言。**

v0.2 起这个承诺扩到多个领域，但**「参考库」这个定位不变** —— 它存的是看到的东西，不是正在做的项目。项目管理、生产任务、素材生成仍然不做。

等某个 domain 里的条目真到 100～300 条之后，再做 Compare / Pattern / Inspiration Board / AI Analyze / Generate Brief。那时候 AI 才是在一个已经形成个人审美的数据集上工作，而不是对着十几张图片凭空总结。

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
- 生产性标签（`cheap-to-animate`）比分类学标签更能指导生产 —— 这类判断是「是/不是」，属 tag；「这条有多便宜好做」才是度量，属 taxonomy。两者互补，不是同一件事
- **分类标签（离散枚举）和度量刻度（连续打分）是两种东西**。混在一套 tag 里会让用户填两遍 —— v0.1 的受控 taxonomy 其实是分类学，被错放在 tag 体系里
- **origin 这类「谁产生的」元数据必须挂在关联表上，不挂在实体表上**。实体只有一行，归属会歧义
- 字段要从数据里长出来，不要提前设计 —— **「正交维度」是例外**：`domain` 不是往条目里塞字段，是决定「哪些字段属于这一条」，它的正确形状由框架定，不由当前数据定
- **「通用化是 100 条之后的结论」这条纪律本身有前提**：它假设「什么时候需要第二个 domain」不可知。前提被否时（0 条数据 = 迁移零成本），纪律要让位
- **冻结文档和解冻记录写在同一份文件里**。删掉旧结论而不留痕，下一个动 schema 的人会拿旧理由挡你
- **新增一层间接查询要重新验收旧判据**。通用化让 Catalog 多一层 join，D3「浏览够不够快」得重新测一遍，不能沿用改之前的结论
- 「第 8 条开始嫌烦」是可执行的验收判据，比「用户体验良好」强一百倍
- **强制字段是最贵的一种设计**。「不打标签就找不回来」这类理由该用**视图**解决（未打标筛选），而不是用**纪律**。纪律是每次都付的摩擦，视图是按需付的
- 「只加不删」与「替换」两种语义混在一个函数里，静默失效的概率很高 —— 摘标签这个动作被当成空操作，查了三轮才定位

---

## §九 已知环境限制

**本机 dev server 与 `next build` 可能起不来**，报`EPERM: operation not permitted, rename ...`（turbopack 重建 `.next` 缓存时的 `CURRENT.next → CURRENT`，以及 `server-reference-manifest.json.tmp → ...json`）。

已排除的可能：`com.apple.provenance` 扩展属性（清掉无效）、换 distDir（无效）、`--webpack` 后端（无效）、非沙箱模式（无效）。**与代码无关** —— 同一份代码在本会话早些时候构建成功过（10 个路由全过）。

替代验证手段：service 层是纯函数 + drizzle，可以用 `node --conditions react-server --import tsx` 直接跑，不经过 HTTP。见 `npm run verify:untagged`。