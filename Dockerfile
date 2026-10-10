# node:24-bookworm-slim。digest 与 navi 保持一致，避免两个基础镜像各自漂移。
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# `npm run build` 会先跑 prepare-next，把 `.next` 链到 /tmp。那是本机
# WorkBuddy 拦截 rename 的绕行，镜像里没有这个拦截。链出去之后，下面
# `COPY .next` 拿到的是断链，构建产物不在这一层里。
# public 可以没有（仓库里没有静态资源），但 COPY 要求源目录存在。
RUN mkdir -p public \
  && ./node_modules/.bin/next build \
  && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runner

WORKDIR /app

# infra 的 deploy 会传 ATLAS_VERSION=<7位 commit>，/healthz 靠它报版本。
# 与 NAVI_VERSION 是同一套机制。
ARG ATLAS_VERSION=dev
ENV NODE_ENV=production
ENV PORT=5600
ENV ATLAS_VERSION=$ATLAS_VERSION
ENV MEDIA_ROOT=/data/media

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/next.config.js ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# ⚠️ 迁移文件是**运行时**读的（`getDatabase()` 里 `migrate()`），不是构建期资源
# —— 少了这一层，容器起来第一次请求就会在 migrate 上 500。
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public

USER node

EXPOSE 5600

CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "5600"]