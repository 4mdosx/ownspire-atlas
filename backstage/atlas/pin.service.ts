import 'server-only'
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { getDatabase } from '@/backstage/db/database'
import { settings } from '@/backstage/db/schema'

/**
 * PIN 的存储与校验。**与 ownspire-raven / ownspire-shrine 的 `pin.service.ts` 同一套逻辑**。
 *
 * 三个项目各有一份，而不是抽成共享包：它们的部署、版本、依赖都是**各自独立的
 * 容器**（infra 里三个服务三个镜像），跨仓库共享代码要引入 workspace 或私有
 * npm 包，而那会让「改一处退避参数要同时发三个版本」变成常态 —— 而退避参数
 * 恰恰是最需要三处一致的东西。所以这里选择**显式复制 + 文件头注明来源**：
 * 一旦三份不一致，改的时候三份一起改，这比抽象失效更容易发现。
 *
 * ============================ 与 raven / shrine 的一处技术差异 ============================
 *
 * 这三个项目的数据访问层**不同**，所以「同一套逻辑」在这里的落地形式也不同：
 *
 * | 项目 | 数据层 | 本文件的读写方式 |
 * |---|---|---|
 * | raven | 原生 SQL（`backstage/db/database.ts` 里的 `run`/`get`） | 同步 |
 * | shrine | 原生 SQL（`getDatabase()` 返回 `DatabaseSync`） | 同步 |
 * | **atlas** | **drizzle-orm**（`getDatabase()` 返回 drizzle 实例） | **异步** |
 *
 * atlas 的 `getDatabase()` 是 `async` 且走 drizzle 的链式查询，所以本文件的
 * 六个存取函数全是 `async`。⚠️ 别照抄 raven 的同步版本过来 —— 那会得到一个
 * 在 atlas 里根本编译不过（拿不到 `sqlite()`，它是模块内私有）。
 *
 * ============================ 散列格式 ============================
 *
 * `scrypt$N$r$p$salt$hash` 六段式。**不是** navi 的三段式 `scrypt$salt$hash`。
 * 理由：raven 原来那版已经踩过「只判字段数」的坑 ——
 * `scrypt$1$2$3$4$5` 恰好也是六个字段，而 N=1 / r=2 / p=3 会让 node 抛
 * `RangeError: Invalid scrypt params`，把「PIN 不正确」变成 500，
 * 调用方完全无法从现象反推是哪一步错了。换成 PIN 之后这条更该守住：
 * 4 位数字空间小到值得认真对待枚举，参数校验漏了就是能被远程利用的拒绝服务。
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number }
) => Promise<Buffer>

export const PIN_HASH_KEY = 'pin.hash'
export const PIN_EPOCH_KEY = 'pin.epoch'
export const PIN_UPDATED_AT_KEY = 'pin.updatedAt'

const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32

/** PIN 长度。与 raven / shrine / navi 一致。 */
export const PIN_LENGTH = 4

// ---------------------------------------------------------------------------
// settings 键值读写
// ---------------------------------------------------------------------------

async function readSetting(key: string): Promise<string | null> {
  const db = await getDatabase()
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
  return row?.value ?? null
}

async function writeSetting(key: string, value: string): Promise<void> {
  const db = await getDatabase()
  await db
    .insert(settings)
    .values({ key, value })
    // ⚠️ ON CONFLICT DO UPDATE 而不是「先查后写」：后者在并发下两个请求
    // 都查不到、然后都走 INSERT，其中一个撞主键报错。而 PIN 更新在
    // 「连续改 PIN」的界面上是有可能并发发生的。
    .onConflictDoUpdate({ target: settings.key, set: { value } })
}

async function deleteSetting(key: string): Promise<void> {
  const db = await getDatabase()
  await db.delete(settings).where(eq(settings.key, key))
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** 有没有设过 PIN。登录页靠它决定进「设置」还是「解锁」。 */
export async function isPinConfigured(): Promise<boolean> {
  return (await readSetting(PIN_HASH_KEY)) !== null
}

/**
 * 当前 epoch。会话校验时与 cookie 里的比对，不一致即失效。
 *
 * 这是「换 PIN 之后旧会话全部作废」的全部机制。
 */
export async function getPinEpoch(): Promise<string | null> {
  return readSetting(PIN_EPOCH_KEY)
}

/** 存一个新 PIN，返回新的 epoch。 */
export async function savePin(pin: string): Promise<string> {
  const hash = await hashPin(pin)
  const epoch = randomUUID()
  const updatedAt = new Date().toISOString()
  await writeSetting(PIN_HASH_KEY, hash)
  await writeSetting(PIN_EPOCH_KEY, epoch)
  await writeSetting(PIN_UPDATED_AT_KEY, updatedAt)
  return epoch
}

/**
 * 校验一个 PIN。
 *
 * ⚠️ 散列不存在一律判否 —— 那是「还没设过」，不是「空 PIN 恰好正确」。
 * 「没配」绝不能等价于「什么都对」。
 */
export async function verifyStoredPin(pin: string): Promise<boolean> {
  const stored = await readSetting(PIN_HASH_KEY)
  if (!stored) return false
  return verifyPinHash(pin, stored)
}

/** 清掉 PIN，回到「未设置」状态。忘记 PIN 时的逃生门。 */
export async function clearStoredPin(): Promise<void> {
  await deleteSetting(PIN_HASH_KEY)
  await deleteSetting(PIN_EPOCH_KEY)
  await deleteSetting(PIN_UPDATED_AT_KEY)
}

// ---------------------------------------------------------------------------
// 散列
// ---------------------------------------------------------------------------

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scrypt(pin, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

/**
 * 校验散列。
 *
 * ⚠️ 参数范围必须显式判，不能只判字段数 —— 理由见文件头。
 * 另外单次散列的内存上限 1 GiB，防一个畸形值把自己 DoS 掉。
 */
export async function verifyPinHash(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts
  const N = Number.parseInt(nRaw, 10)
  const r = Number.parseInt(rRaw, 10)
  const p = Number.parseInt(pRaw, 10)
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  // N 必须是 2 的幂（scrypt 的硬性要求）；r / p 至少为 1。
  if (N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return false
  const memory = 128 * N * r
  if (memory <= 0 || memory > 1 << 30) return false
  let expected: Buffer
  let salt: Buffer
  try {
    expected = Buffer.from(hashRaw, 'base64url')
    salt = Buffer.from(saltRaw, 'base64url')
  } catch {
    return false
  }
  if (expected.length === 0 || salt.length === 0) return false
  const derived = (await scrypt(pin, salt, expected.length, {
    N,
    r,
    p,
    maxmem: memory * 2,
  })) as Buffer
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}