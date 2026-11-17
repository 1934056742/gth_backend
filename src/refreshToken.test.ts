import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findValidRefreshToken,
  issueRefreshToken,
  revokeRefreshToken,
  type RefreshTokenPrisma
} from './refreshToken.ts';
import { hashToken, signAccessToken, signRefreshToken } from './token.ts';

/**
 * 刷新令牌存储逻辑测试（用内存版 Prisma 打桩，不连真实数据库）
 *
 * 对应需求：「每次登录删除该用户之前的刷新 token，然后重新创建一条」
 * 所以重点验证：
 *   1. 同一用户反复签发，数据库里始终只有一条；
 *   2. 新记录生效后，旧 token 立即失效（旧设备被挤下线）；
 *   3. 过期 / 摘要不匹配 / 无记录 一律判为无效；
 *   4. 登出（revoke）后令牌不可再用。
 *
 * 运行：npm test
 */

// ---------- 内存版 Prisma：只实现 refreshToken 这个 delegate ----------
function createFakePrisma() {
  const rows: Array<{ userId: number; tokenHash: string; expiresAt: Date }> = [];
  const prisma: RefreshTokenPrisma = {
    refreshToken: {
      async deleteMany({ where }: any = {}) {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (where?.userId === undefined || rows[i]!.userId === where.userId) rows.splice(i, 1);
        }
        return { count: before - rows.length };
      },
      async create({ data }) {
        // 模拟数据库的 userId 唯一约束
        if (rows.some((row) => row.userId === data.userId)) {
          throw new Error('Unique constraint failed on userId');
        }
        rows.push({ ...data });
        return { id: rows.length, ...data };
      },
      async findUnique({ where }) {
        return rows.find((row) => row.userId === where.userId) ?? null;
      },
      async delete({ where }) {
        const index = rows.findIndex((row) => row.userId === where.userId);
        if (index < 0) throw new Error('Record not found');
        return rows.splice(index, 1)[0];
      }
    }
  };
  return { prisma, rows };
}

describe('issueRefreshToken：一人一条，删旧建新', () => {
  it('首次签发会在数据库里留下一条记录', async () => {
    const { prisma, rows } = createFakePrisma();
    const token = await issueRefreshToken(prisma, 22);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.userId, 22);
    // 只存摘要，不存明文
    assert.equal(rows[0]!.tokenHash, hashToken(token));
    assert.ok(!rows[0]!.tokenHash.includes(token));
  });

  it('同一用户再次登录：仍然只有一条记录，且是新的那条', async () => {
    const { prisma, rows } = createFakePrisma();
    const first = await issueRefreshToken(prisma, 22);
    const second = await issueRefreshToken(prisma, 22);
    assert.equal(rows.length, 1, '必须删除旧记录');
    assert.notEqual(first, second, '两次签发的 token 必须不同');
    assert.equal(rows[0]!.tokenHash, hashToken(second));
  });

  it('重新登录后，旧刷新令牌立即失效（旧设备被挤下线）', async () => {
    const { prisma } = createFakePrisma();
    const first = await issueRefreshToken(prisma, 22);
    const second = await issueRefreshToken(prisma, 22);
    assert.equal(await findValidRefreshToken(prisma, 22, first), null, '旧令牌必须失效');
    assert.ok(await findValidRefreshToken(prisma, 22, second), '新令牌必须可用');
  });

  it('不同用户互不影响，各有一条', async () => {
    const { prisma, rows } = createFakePrisma();
    const a = await issueRefreshToken(prisma, 1);
    const b = await issueRefreshToken(prisma, 2);
    assert.equal(rows.length, 2);
    assert.ok(await findValidRefreshToken(prisma, 1, a));
    assert.ok(await findValidRefreshToken(prisma, 2, b));
    // 交叉使用无效
    assert.equal(await findValidRefreshToken(prisma, 1, b), null);
  });

  it('记录里的过期时间是 7 天后', async () => {
    const { prisma, rows } = createFakePrisma();
    await issueRefreshToken(prisma, 22);
    const ttl = rows[0]!.expiresAt.getTime() - Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    // 允许几秒误差
    assert.ok(Math.abs(ttl - sevenDays) < 5000, `实际剩余 ${ttl}ms`);
  });
});

describe('findValidRefreshToken：各种失效场景', () => {
  it('没有记录时返回 null（没登录过 / 已登出）', async () => {
    const { prisma } = createFakePrisma();
    assert.equal(await findValidRefreshToken(prisma, 999, signRefreshToken(999)), null);
  });

  it('token 与记录不匹配时返回 null（伪造的 token）', async () => {
    const { prisma } = createFakePrisma();
    await issueRefreshToken(prisma, 22);
    const fake = signRefreshToken(22);
    assert.equal(await findValidRefreshToken(prisma, 22, fake), null);
  });

  it('已过期的记录判为无效，并顺手清理掉', async () => {
    const { prisma, rows } = createFakePrisma();
    const token = await issueRefreshToken(prisma, 22);
    rows[0]!.expiresAt = new Date(Date.now() - 1000);
    assert.equal(await findValidRefreshToken(prisma, 22, token), null);
    assert.equal(rows.length, 0, '过期记录应被清理');
  });
});

describe('revokeRefreshToken：登出', () => {
  it('登出后刷新令牌不再可用', async () => {
    const { prisma, rows } = createFakePrisma();
    const token = await issueRefreshToken(prisma, 22);
    await revokeRefreshToken(prisma, 22);
    assert.equal(rows.length, 0);
    assert.equal(await findValidRefreshToken(prisma, 22, token), null);
  });

  it('登出不存在的记录不报错（幂等）', async () => {
    const { prisma } = createFakePrisma();
    await revokeRefreshToken(prisma, 404);
    assert.ok(true);
  });
});

describe('访问令牌与刷新令牌不可混用', () => {
  it('即使把访问令牌塞进刷新接口，类型校验也会拦下', async () => {
    const { prisma } = createFakePrisma();
    await issueRefreshToken(prisma, 22);
    // verifyToken(accessToken, 'refresh') 返回 null → 接口层会返回 401
    const { verifyToken } = await import('./token.ts');
    assert.equal(verifyToken(signAccessToken(22), 'refresh'), null);
  });
});
