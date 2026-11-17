import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  hashToken,
  refreshTokenExpiry,
  signAccessToken,
  signRefreshToken,
  ttlHuman,
  verifyToken
} from './token.ts';

/**
 * 双 token 纯函数测试
 *
 * 这里锁住的是「安全边界」，任何一条被破坏都可能让 30 分钟的短令牌形同虚设：
 *   1. 两种令牌的时效必须是 30 分钟 / 7 天；
 *   2. 校验必须区分类型（刷新令牌不能当访问令牌用，反之亦然）；
 *   3. 数据库只存 sha256 摘要，且同一 token 摘要稳定；
 *   4. 篡改过的 token 一律校验失败。
 *
 * 运行：npm test
 */

describe('token 时效常量', () => {
  it('访问令牌是 30 分钟', () => {
    assert.equal(ACCESS_TOKEN_TTL_SECONDS, 30 * 60);
  });

  it('刷新令牌是 7 天', () => {
    assert.equal(REFRESH_TOKEN_TTL_SECONDS, 7 * 24 * 60 * 60);
  });

  it('刷新令牌过期时间点 = 现在 + 7 天', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expiry = refreshTokenExpiry(now);
    assert.equal(expiry.getTime() - now.getTime(), REFRESH_TOKEN_TTL_SECONDS * 1000);
  });
});

describe('ttlHuman', () => {
  it('能读成天 / 小时 / 分钟', () => {
    assert.equal(ttlHuman(7 * 24 * 60 * 60), '7 天');
    assert.equal(ttlHuman(30 * 60), '30 分钟');
    assert.equal(ttlHuman(3600), '1 小时');
    assert.equal(ttlHuman(90), '90 秒');
  });
});

describe('signAccessToken / verifyToken', () => {
  it('访问令牌能被按 access 校验通过，并带出 userId', () => {
    const token = signAccessToken(22);
    const payload = verifyToken(token, 'access');
    assert.ok(payload);
    assert.equal(payload!.userId, 22);
    assert.equal(payload!.type, 'access');
  });

  it('访问令牌的有效期约 30 分钟', () => {
    const token = signAccessToken(1);
    const payloadPart = token.split('.')[1] ?? '';
    const decoded = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    assert.equal(decoded.exp - decoded.iat, ACCESS_TOKEN_TTL_SECONDS);
  });

  it('访问令牌不能被当成刷新令牌使用（类型不匹配）', () => {
    const token = signAccessToken(22);
    assert.equal(verifyToken(token, 'refresh'), null);
  });
});

describe('signRefreshToken / verifyToken', () => {
  it('刷新令牌有效期约 7 天', () => {
    const token = signRefreshToken(22);
    const payloadPart = token.split('.')[1] ?? '';
    const decoded = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
    assert.equal(decoded.exp - decoded.iat, REFRESH_TOKEN_TTL_SECONDS);
  });

  it('刷新令牌带唯一 jti，同一用户连续签发也不同', () => {
    const a = signRefreshToken(22);
    const b = signRefreshToken(22);
    assert.notEqual(a, b);
    const payload = verifyToken(a, 'refresh');
    assert.ok(payload!.jti);
  });

  it('刷新令牌不能被当成访问令牌使用（防止变相延长访问凭证）', () => {
    const token = signRefreshToken(22);
    assert.equal(verifyToken(token, 'access'), null);
  });
});

describe('token 安全边界', () => {
  it('篡改过的 token 校验失败', () => {
    const token = signAccessToken(22);
    // 改掉最后几个字符，签名就对不上了
    const tampered = token.slice(0, -3) + 'abc';
    assert.equal(verifyToken(tampered, 'access'), null);
  });

  it('随便乱填的字符串校验失败', () => {
    assert.equal(verifyToken('not-a-token', 'access'), null);
    assert.equal(verifyToken('', 'access'), null);
  });

  it('sha256 摘要稳定且不泄露原文', () => {
    const token = signRefreshToken(7);
    const h1 = hashToken(token);
    const h2 = hashToken(token);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
    assert.ok(!h1.includes(token));
    // 不同 token 摘要不同
    assert.notEqual(h1, hashToken(signRefreshToken(7)));
  });
});
