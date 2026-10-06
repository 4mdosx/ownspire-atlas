/**
 * 构建期注入的版本号。
 *
 * Dockerfile 的 `ARG ATLAS_VERSION` 经环境变量落在这里 —— infra 的 deploy
 * 靠 /healthz 返回的 7 位 commit 判断「跑的是哪一版」，这个值就是那条链的源头。
 * 本地开发时是 'dev'。
 */
export const ATLAS_VERSION = process.env.ATLAS_VERSION ?? 'dev'