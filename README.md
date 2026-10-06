# Creative Atlas

个人创意采集库。第一期只有 **Monster** 一个 Collection —— 先把「看到参考 → 10–30 秒录入 → 能分类/搜索」这条链路跑通，别的一概不做。

范围与验收标准见 [`docs/00-scope.md`](docs/00-scope.md)。

## 为什么是 v0 而不是「创意管理系统」

要验证的不是功能，是**你还愿不愿意继续收集**。

采集系统的成败几乎从不由 schema 决定，而由「第 8 条开始是不是变烦了」决定。所以 v0 的判据是可执行的那一条：**连续录 20 条不觉得烦**。嫌烦就停下来修 Capture UX，不进下一阶段。

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

打开 http://localhost:5600

### 关于 npm 源

`.npmrc` 里锁了 `registry.npmmirror.com`。原因是本机全局registry 指向一个**需要 token 的内网镜像**，而官方源在本机网络下SSL 验证会失败（`curl` 返回 `000`）—— 不显式指定就会卡在重试里（实测 49 分钟仍未完成）。

用公共镜像不需要任何凭据，克隆到别的机器上也能直接 `npm install`。

## 数据放在哪

```
local.db              条目与标签。imagePath 存相对路径
media/<entryId>/      图片本体，一条目一目录
```

**图片走磁盘，DB 只存相对路径。** 这样导出时 JSON + media 目录一起打包就完整了，浏览器也不用从 db 里拉 BLOB。

清库重来（⚠️ 无undo）：

```bash
npm run reset-db -- RESET
```

## 目录结构

```
app/                页面与 API 路由
  api/atlas/        条目 / 标签 / 图片 / 导入导出
  healthz/          部署健康检查
backstage/
  db/               schema、幂等迁移、init/reset 脚本
  atlas/            entry / tag / media 三个 service
types/atlas.ts      共享类型与受控 taxonomy
docs/00-scope.md    v0 范围冻结（唯一凭据）
media/              图片，不进git
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