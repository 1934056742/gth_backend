import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateNewPassword,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH
} from './password.ts';

/**
 * 新密码强度校验测试
 *
 * 规则来源：src/password.ts
 *   - 6~32 位
 *   - 不能为空 / 非字符串
 *   - 不能纯数字、不能纯字母（要求混合）
 *   - 不能包含空白字符
 *
 * 这些规则同时被「修改密码」接口（后端）和 PasswordDialog.vue（前端）使用，
 * 前端 PasswordDialog.vue 的 validatePassword 与之保持一致，改动时三处要同步。
 */
describe('validateNewPassword', () => {
  it('合法密码返回 null', () => {
    assert.equal(validateNewPassword('abc12345'), null);
    assert.equal(validateNewPassword('aB1!xY'), null);
    assert.equal(validateNewPassword('Passw0rd'), null);
  });

  it('空值与非字符串被拒绝', () => {
    assert.equal(validateNewPassword(''), '新密码不能为空');
    assert.equal(validateNewPassword(undefined), '新密码不能为空');
    assert.equal(validateNewPassword(null), '新密码不能为空');
    assert.equal(validateNewPassword(123456), '新密码不能为空');
    assert.equal(validateNewPassword({}), '新密码不能为空');
  });

  it('长度边界：最短 6 位、最长 32 位', () => {
    // 刚好 6 位且字母数字混合 → 通过
    assert.equal(validateNewPassword('a12345'), null);
    // 5 位 → 太短
    assert.match(validateNewPassword('a1234') ?? '', /至少 6 位/);

    // 刚好 32 位 → 通过（a1 重复 16 次）
    const maxOk = 'a1'.repeat(PASSWORD_MAX_LENGTH / 2);
    assert.equal(maxOk.length, PASSWORD_MAX_LENGTH);
    assert.equal(validateNewPassword(maxOk), null);

    // 33 位 → 太长
    const tooLong = 'a1'.repeat(PASSWORD_MAX_LENGTH / 2) + 'x';
    assert.match(validateNewPassword(tooLong) ?? '', /最多 32 位/);
  });

  it('纯数字被拒绝', () => {
    assert.match(validateNewPassword('123456') ?? '', /纯数字/);
    assert.match(validateNewPassword('1234567890') ?? '', /纯数字/);
  });

  it('纯字母被拒绝', () => {
    assert.match(validateNewPassword('abcdef') ?? '', /纯字母/);
    assert.match(validateNewPassword('ABCDEFGH') ?? '', /纯字母/);
  });

  it('包含空格 / 制表符等空白字符被拒绝', () => {
    assert.match(validateNewPassword('abc 123') ?? '', /空格/);
    assert.match(validateNewPassword('abc\t123') ?? '', /空格/);
    assert.match(validateNewPassword(' abc123') ?? '', /空格/);
  });

  it('常量与实现一致', () => {
    assert.equal(PASSWORD_MIN_LENGTH, 6);
    assert.equal(PASSWORD_MAX_LENGTH, 32);
    // 校验顺序：长度优先于字符构成。"a1234" 长度不够 → 报长度；
    // "abcdef" 长度够但是纯字母 → 报纯字母。
    assert.match(validateNewPassword('a1234') ?? '', /至少 6 位/);
    assert.match(validateNewPassword('abcdef') ?? '', /纯字母/);
  });
});
