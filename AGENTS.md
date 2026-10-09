# AGENTS.md

给任何进这个仓库的 agent（人类或 AI）的硬性要求。**先读这份，再动任何文件。**

---

## 一、删除操作的唯一正确姿势

⚠️ **本仓库的文件删除量极易触发批量删除告警。** 不是因为操作危险，是因为 `.next/` 一次 build 就写几百个文件 —— 一句 `rm -rf .next` 就够越过阈值。

| 想做的事 |❌ 不要 |✅ 要 |
|---|---|---|
| 清类型缓存（改了目录结构后 `tsc` 报假错误） | `rm -rf .next` | `rm -rf .next/types` |
| 清库重来 | `rm -f local.db*` | `npm run reset-db -- RESET` |
| 删单个文件 | `rm file` | `git rm file` |
| 删整个目录 | `rm -rf <dir>` | 先 `find <dir> -type f \| wc -l` 看清楚要删多少 |

**为什么 `reset-db` 一定要带 `RESET` 参数**：那是刻意设计的一次性确认门禁 —— 数据库里是你一个下午的采集，误删不可逆。**裸 `rm` 绕过这道门禁，等于把护栏拆了。**

判断标准：**要删的东西能不能重新生成？** `.next` 能（重跑 build），`local.db` 不能（里面是采集数据）。前者随便删，后者必须走脚本。

---

## 二、本机环境的坑

### dev server 可能起不来

`next dev` 与 `next build` 都可能报 `EPERM: operation not permitted, rename .../CURRENT.next -> .../CURRENT`（turbopack 重建 `.next` 缓存）。

已排除：扩展属性、换 distDir、`--webpack` 后端、非沙箱模式、复制到 /tmp —— 全部无效。**与代码无关。**

**绕过办法是直接跑 service 层**，不经过 HTTP：

```bash
node --conditions react-server --import tsx scripts/verify-atlas.ts
```

- `--conditions react-server` → 让 `import 'server-only'` 解析到官方空桩（不写这个 flag，脚本是颗真炸弹）
- `--import tsx` → 让 `@/*` 路径别名生效
- ⚠️ tsx 以 CJS 输出，**不支持 top-level await** —— 脚本要包在 `main()` 里

### zsh

- heredoc 里的 `${...}` 会被展开 —— 写含模板字符串的脚本用 Write 工具
- `rm -f path/*.lock` 无匹配时整条命令不执行 —— 用 `find -delete`

---

## 三、schema 改动的门禁

`backstage/db/database.ts` 的 `ensureSchema` 只创建当前结构和首次种子。旧库结构必须先做显式、可验证的迁移；运行时不做兼容搬运。

⚠️ **破坏性 schema 变更的规则**：撞到 legacy 表且非空时**直接抛错，不自动搬数据**。

理由：真到了有数据的时候再做一次显式迁移 —— 那时数据形态、id 语义、media 目录都要人工确认。**自动迁移的静默错误比停下来问更贵。**

改 schema 前先确认库里有多少条：

```bash
sqlite3 local.db "SELECT count(*) FROM entries"
```

**0 条是迁移的免费窗口**，趁那时候改最省事。

---

## 四、这个项目的三条不可破纪律

1. **平表 + 视图，不是目录树。** Inbox / Catalog / Detail 是同一张表的三个筛选条件。加一个 `status` 值应该是「多一个按钮」，不是「迁移一次目录」。

2. **强制字段只有 `source` 一项（URL 或出版物）。** tags 和 axis values 全部可空。Atlas 首先是采集系统，不是填写调查问卷。**欠账用「未打标」视图收口，不用纪律。**

3. **当前 Axis 定义以 `design_axes` 表为准。** `types/atlas.ts` 的六根轴仅用于新库首次播种；写入校验读取数据库中的轴。当前 domain 列表仍是代码常量。

**改动前先读 `docs/00-scope.md`。** 那是范围凭据，解冻理由和改写记录都在同一份文件里。

---

## 五、验证

```bash
npm run verify   # 当前 service 层断言
tsc --noEmit     # 类型
```

**验证脚本抓 bug 的能力是真的** —— v0.2 那轮它抓出了两个我自己写错的实现（origin 被误删、星级档位算错）。**改 service 层就必须补断言。**

注意验证脚本里几个反复踩的点：

- 环境变量必须在 `database.ts` 被加载**之前**设好（`DB_FILE_NAME` / `MEDIA_ROOT` 指向 `/tmp` 下的临时路径）
- 断言失败时打印 `detail` —— 不然不知道是「行为错」还是「报错文案变了」

---

## 六、提交前自查

```bash
npx tsc --noEmit && npm run verify
```

两件都过了再提交。**别把「类型过了但没跑验证」当成验证过了** —— service 层的 SQL 错误和 origin 这类语义错误，tsc 一个都抓不到。
