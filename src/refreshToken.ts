// ============================================================
// 刷新令牌的数据库操作
//
// 表结构见 prisma/schema.prisma 的 RefreshToken：
//   userId 唯一 → 一个用户最多一条记录，天然满足
//   「每次登录删除该用户之前的刷新 token，然后重新创建一条」。
//
// 为什么抽成独立模块：
//   index.ts 里要处理登录 / 注册 / 刷新 / 登出四个流程，
//   把「删旧建新」的原子操作收在一处，避免四处各写一遍写漏。
// ============================================================

import { hashToken, refreshTokenExpiry, signRefreshToken } from './token.ts';

/** 只声明本模块用到的最小 Prisma 接口，方便单测用内存版打桩 */
export interface RefreshTokenDelegate {
  deleteMany(args?: { where?: any }): Promise<{ count: number }>;
  create(args: { data: { userId: number; tokenHash: string; expiresAt: Date } }): Promise<any>;
  findUnique(args: { where: { userId: number } }): Promise<any | null>;
  delete(args: { where: { userId: number } }): Promise<any>;
}

export interface RefreshTokenPrisma {
  refreshToken: RefreshTokenDelegate;
}

/**
 * 为指定用户签发并保存一条新的刷新令牌。
 *
 * 顺序很重要：先删该用户的旧记录，再插入新记录。
 *   - 这样「同一用户只有一条有效刷新令牌」；
 *   - 多设备场景下，后登录的设备会把先登录的挤掉（符合需求描述）。
 *
 * @returns 明文刷新令牌（只有这一次能拿到，数据库里只有 sha256 摘要）
 */
export async function issueRefreshToken(
  prisma: RefreshTokenPrisma,
  userId: number
): Promise<string> {
  const token = signRefreshToken(userId);
  // 先删旧：userId 上有唯一约束，不删会插入失败
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: refreshTokenExpiry()
    }
  });
  return token;
}

/**
 * 校验刷新令牌是否仍然可用（存在 + 未过期 + 摘要匹配）。
 *
 * @returns 通过则返回记录，否则 null
 */
export async function findValidRefreshToken(
  prisma: RefreshTokenPrisma,
  userId: number,
  token: string
): Promise<any | null> {
  const record = await prisma.refreshToken.findUnique({ where: { userId } });
  if (!record) return null;
  // 摘要不匹配：说明是旧 token（已被新登录覆盖）或伪造的
  if (record.tokenHash !== hashToken(token)) return null;
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    // 过期了顺手清掉，避免脏数据堆积
    await prisma.refreshToken.deleteMany({ where: { userId } });
    return null;
  }
  return record;
}

/** 删除某用户的刷新令牌（登出 / 改密后强制重新登录时使用） */
export async function revokeRefreshToken(
  prisma: RefreshTokenPrisma,
  userId: number
): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}
