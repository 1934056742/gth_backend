// ============================================================
// 双 token 签发 / 校验（纯函数，方便写单元测试）
//
// 方案说明（为什么需要两个 token）：
//   - access token（访问令牌）：放进请求头 Authorization，短时效（30 分钟）。
//     它每次请求都发出去，暴露面大，所以寿命必须短。
//   - refresh token（刷新令牌）：只用于「换新的访问令牌」，长时效（7 天），
//     存在数据库里，登录时删除该用户旧记录并新建一条（一人一条）。
//     访问令牌过期后，前端用它静默换一个新的，用户无感知。
//
// 关键安全点：
//   1. 两个 token 用 type 字段区分（'access' / 'refresh'），校验时强校验，
//      避免「拿刷新令牌当访问令牌用」变相延长访问令牌寿命；
//   2. 数据库只存刷新令牌的 sha256 摘要，不存明文；
//   3. 刷新令牌带 jti（随机唯一 id），使每次签发的字符串都不同——这样
//      同一秒内多次登录也不会产生完全相同的 token。
// ============================================================

import crypto from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { JWT_SECRET } from './auth.ts';

/** 访问令牌有效期：30 分钟（对应需求「放入请求头的 token 30 分钟失效」） */
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 60;

/** 刷新令牌有效期：7 天（对应需求「刷新的 token 7 天失效」） */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** token 类型：访问令牌 / 刷新令牌 */
export type TokenType = 'access' | 'refresh';

export interface TokenPayload {
  userId: number;
  type: TokenType;
  /** 刷新令牌的唯一 id，让每次签发的字符串都不同（避免同一秒内签发出完全相同的结果） */
  jti?: string;
}

/** 把秒数表述成人能读的文案，用于接口返回值 / 前端提示 */
export function ttlHuman(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

/** 签发访问令牌（30 分钟） */
export function signAccessToken(userId: number): string {
  return jwt.sign({ userId, type: 'access' }, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL_SECONDS
  });
}

/** 签发刷新令牌（7 天），带随机 jti */
export function signRefreshToken(userId: number): string {
  const jti = crypto.randomBytes(16).toString('hex');
  return jwt.sign({ userId, type: 'refresh', jti }, JWT_SECRET, {
    expiresIn: REFRESH_TOKEN_TTL_SECONDS
  });
}

/** 刷新令牌的过期时间点（用于写入数据库 expiresAt） */
export function refreshTokenExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
}

/**
 * 计算 token 的 sha256 摘要。
 * 数据库里只保存它，校验时把收到的 token 同样算一次再比对。
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * 校验 token 并返回 payload。
 * 类型不匹配（比如拿 refresh 当 access 用）同样视为无效。
 *
 * @returns 校验通过返回 payload；失败返回 null（调用方统一按 401 处理）
 */
export function verifyToken(token: string, expected: TokenType): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: false }) as
      | string
      | JwtPayload;
    if (typeof decoded !== 'object' || !decoded) return null;
    const userId = (decoded as JwtPayload).userId;
    const type = (decoded as JwtPayload).type;
    if (typeof userId !== 'number') return null;
    // 老版本签发的 token 没有 type 字段，这里按 access 兼容，
    // 避免升级后所有已登录用户被强制踢下线。
    const actualType: TokenType = type === 'refresh' ? 'refresh' : 'access';
    if (actualType !== expected) return null;
    const jti = (decoded as JwtPayload).jti;
    return {
      userId,
      type: actualType,
      ...(typeof jti === 'string' ? { jti } : {})
    };
  } catch {
    return null;
  }
}

/**
 * 判断 token 失败的原因：过期 / 其他（签名不对、格式错）。
 * 前端据此决定是「静默刷新」还是「直接回登录页」。
 */
export function isExpiredTokenError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'TokenExpiredError';
}
