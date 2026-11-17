// ============================================================
// JWT 鉴权中间件（抽成独立模块，方便多个路由文件复用）
// 作用：检查请求头里的 token，如果有效就把 userId 放到 req 上
// 用法：app.get('/api/xxx', authMiddleware, handler)
// ============================================================

import type express from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';

// JWT 密钥：统一从环境变量读取，未配置时用开发默认值兜底。
// 单独抽出来导出，index.ts（签发 token）与 auth.ts（校验 token）共用同一份，
// 避免两边各写一遍导致签名/验签用的密钥不一致。
export const JWT_SECRET = process.env.JWT_SECRET || 'geek-task-hub-secret';

// 扩展 Express 的 Request 类型，加上 userId 字段
export interface AuthRequest extends express.Request {
  userId?: number;
}

// 解析 "Bearer xxx" 形式的 Authorization 头，返回 token 本体
function extractToken(req: express.Request): string | undefined {
  const authHeader = req.headers.authorization;
  // 没有这个字段，或者不是以 "Bearer " 开头，说明没登录
  if (!authHeader || !authHeader.startsWith('Bearer ')) return undefined;
  const token = authHeader.slice('Bearer '.length).trim();
  return token || undefined;
}

/**
 * 访问令牌校验失败时的统一响应。
 *
 * code 字段的作用：前端拦截器据此区分两种情况——
 *   TOKEN_EXPIRED：只是过期了 → 拿刷新令牌静默换一个新的，用户无感知；
 *   TOKEN_INVALID：令牌无效（签名不对 / 被篡改 / 不是访问令牌）→ 直接回登录页。
 * 同时保留原有 error 文案，老前端不改也不会坏。
 */
export const AUTH_ERROR_EXPIRED = 'TOKEN_EXPIRED';
export const AUTH_ERROR_INVALID = 'TOKEN_INVALID';

function rejectAuth(res: express.Response, expired: boolean) {
  return res.status(401).json({
    error: expired ? '登录已过期，请重新登录' : 'Token 无效或已过期',
    code: expired ? AUTH_ERROR_EXPIRED : AUTH_ERROR_INVALID
  });
}

export function authMiddleware( 
  req: AuthRequest,
  res: express.Response,
  next: express.NextFunction
) {
  const token = extractToken(req);
  if (!token) {
    return rejectAuth(res, false);
  }

  try {
    // 用 JWT_SECRET 验证 token 是否有效，并解出里面的 userId
    const decoded = jwt.verify(token, JWT_SECRET) as string | JwtPayload;
    const userId = typeof decoded === 'object' && decoded ? decoded.userId : undefined;
    if (!userId || typeof userId !== 'number') {
      return rejectAuth(res, false);
    }
    // 双 token 方案：刷新令牌（type === 'refresh'）只能用来换新的访问令牌，
    // 不能当访问令牌直接调业务接口，否则等于把 7 天有效期用成了访问凭证。
    if (typeof decoded === 'object' && decoded && decoded.type === 'refresh') {
      return rejectAuth(res, false);
    }
    // 把 userId 放到 req 上，后面的接口就能用 req.userId 了
    req.userId = userId;
    next();
  } catch (error) {
    // token 无效或过期：过期的情况单独标记，让前端走去静默刷新
    const expired = !!error && typeof error === 'object' && (error as { name?: string }).name === 'TokenExpiredError';
    return rejectAuth(res, expired);
  }
}

// 静态文件（下载/预览）无法通过请求头携带 token（浏览器直接发 GET），
// 因此额外支持 query 参数 ?token=xxx 作为兜底校验方式。
export function authMiddlewareWithQueryToken(
  req: AuthRequest,
  res: express.Response,
  next: express.NextFunction
) {
  if (!req.headers.authorization && typeof req.query.token === 'string' && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  return authMiddleware(req, res, next);
}
