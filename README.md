# Creative Atlas

个人创意参考库。当前只开放 **Creature Design**：快速采集参考、记录观察与判断，用 Tag 和 Axis 找回条目。设计范围与历史决策见 [`docs/00-scope.md`](docs/00-scope.md)。修改仓库前请先读 [`AGENTS.md`](AGENTS.md)。

## 当前数据模型

| 表 | 用途 |
|---|---|
| `entries` | 条目、来源链接、观察、判断、采集状态和当前图片路径 |
| `monster_entries` | Creature Design 条目的 1:1 扩展标记 |
| `tags` / `entry_tags` | 离散标签及其条目关联；`origin`、`ruleId`、`confidence`（0–1）存在关联上 |
| `design_spaces` / `design_axes` | 设计空间和轴定义；数据库中的轴是运行时唯一依据 |
| `entry_axis_values` | 条目在每个空间中的当前 Axis 值，范围 0–1；未评分没有记录，0 分则有记录 |
| `import_id_map` | 导入幂等映射 |

`types/atlas.ts` 中的六根 Creature 轴只在新数据库首次创建时播种。之后新增或编辑轴由 `design_axes` 管理。Tag 和 Axis 独立：Tag 表达离散判断，Axis 表达连续位置。当前值以 `axisValues` 在 API、类型和界面间传递；数据库使用 `entry_axis_values`。项目不再读取 `taxonomy`、`notes` 或旧 domain 别名。

手工新增条目默认进入 `pending_ai`（待 AI 处理）；后续状态为 `inbox` 和 `reviewed`。当前项目尚未实现自动 AI 处理，状态可在详情的“基本信息”页调整。详情另有 Tags、Axis、Design Analysis 页；Design Analysis 依次记录观察、判断和保存目的。Tag 不设分组，关联置信度在 Tags 页按百分比编辑。

当前实现仍以单张图片路径和可覆盖的 Axis 当前值为主；文档中的多 Asset、Provenance、Append-only Annotation History 等 LV0 后续能力尚未落地。不要把当前值表当作 Annotation History。

## 本地开发

需要 Node.js 24.15 或更新版本。

```bash
npm install
cp .env.example .env
npm run init-db
npm run dev
```

默认数据库位于 `~/.local/share/creative-atlas/atlas.db`。`DB_FILE_NAME` 可显式指定一个数据库绝对路径；图片存于 `MEDIA_ROOT`（默认仓库中的 `media/`）。导出包需同时携带 manifest 与图片文件。端口为 5600。

已有数据库若仍含 `tags.groupName`，运行一次 `python3 scripts/migrate-tags-confidence-status.py /绝对路径/atlas.db`。脚本先在数据库旁创建一致性备份，再迁移并检查条目数、标签关联、外键和完整性；旧 `reference` 记录会转为 `reviewed`。

## 验证

```bash
npx tsc --noEmit --incremental false
npm run verify
npm run verify:axis
npm run verify:grid
```

`verify` 直接调用 service 层；`verify:axis` 检查新库只包含当前 Axis 表，并验证重新打开时种子不会重复。当前导出格式为 `formatVersion: 6`，只接受同版本包；旧包需要显式转换，不会在导入时猜测字段含义。

## 部署和备份

通过 [ownspire-infra](../ownspire-infra) 部署时，备份必须同时包含 SQLite 数据库和 `media/`。清库会删除采集数据，仅在明确需要时运行：

```bash
npm run reset-db -- RESET
```
