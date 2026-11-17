import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canListFileWithoutTask, canDeleteFile, canViewFileContent } from './uploadPermission.ts';

/**
 * 文件可见性 / 删除权限测试
 *
 * 规则来源：src/upload.ts
 *   GET    /api/upload/files        → 不带 taskId 时走 canListFileWithoutTask
 *   DELETE /api/upload/files/:id    → 走 canDeleteFile
 *
 * 业务背景：
 *   - 「文件上传」页是管理员专属后台视图（前端路由 meta.role = admin），
 *     管理员需要能查看并删除【任意人】上传的文件；
 *   - 「任务详情」页普通成员也能进入，成员仍然只能删除自己上传的文件。
 *
 * 注意：不属于自己的文件，后端统一返回 404（而不是 403），避免暴露文件是否存在。
 */
const ADMIN_ID = 1;
const MEMBER_ID = 2;
const OTHER_ID = 3;

describe('canListFileWithoutTask（文件上传页：不带 taskId 的列表）', () => {
  it('管理员能看到所有人上传的文件', () => {
    const others = { ownerId: OTHER_ID };
    const own = { ownerId: ADMIN_ID };
    assert.equal(canListFileWithoutTask(others, ADMIN_ID, true), true);
    assert.equal(canListFileWithoutTask(own, ADMIN_ID, true), true);
  });

  it('普通成员只能看到自己上传的文件', () => {
    assert.equal(canListFileWithoutTask({ ownerId: MEMBER_ID }, MEMBER_ID, false), true);
    assert.equal(canListFileWithoutTask({ ownerId: OTHER_ID }, MEMBER_ID, false), false);
  });

  it('角色不是管理员时，即使 id 恰好相同也不该放开他人文件', () => {
    // ownerId 相同 → 本来就能看；这里验证「非管理员 + 他人文件」的组合恒为 false
    assert.equal(canListFileWithoutTask({ ownerId: OTHER_ID + 1 }, MEMBER_ID, false), false);
  });

  it('历史文件没有 ownerId 时：管理员可见，普通成员不可见', () => {
    const legacy = { ownerId: undefined };
    assert.equal(canListFileWithoutTask(legacy, ADMIN_ID, true), true);
    assert.equal(canListFileWithoutTask(legacy, MEMBER_ID, false), false);
  });
});

describe('canViewFileContent（查看文件内容）', () => {
  it('管理员可以查看任意人上传的文件内容', () => {
    assert.equal(canViewFileContent({ ownerId: OTHER_ID }, ADMIN_ID, true), true);
    assert.equal(canViewFileContent({ ownerId: ADMIN_ID }, ADMIN_ID, true), true);
  });

  it('普通成员只能查看自己上传的文件内容', () => {
    assert.equal(canViewFileContent({ ownerId: MEMBER_ID }, MEMBER_ID, false), true);
    assert.equal(canViewFileContent({ ownerId: OTHER_ID }, MEMBER_ID, false), false);
  });

  it('历史文件没有 ownerId 时：管理员可查看，普通成员不可查看', () => {
    const legacy = { ownerId: undefined };
    assert.equal(canViewFileContent(legacy, ADMIN_ID, true), true);
    assert.equal(canViewFileContent(legacy, MEMBER_ID, false), false);
  });

  it('与列表可见性同一口径：列表能看到的文档就一定能打开', () => {
    const cases = [
      { file: { ownerId: ADMIN_ID }, userId: ADMIN_ID, isAdmin: true },
      { file: { ownerId: MEMBER_ID }, userId: ADMIN_ID, isAdmin: true },
      { file: { ownerId: MEMBER_ID }, userId: MEMBER_ID, isAdmin: false },
      { file: { ownerId: OTHER_ID }, userId: MEMBER_ID, isAdmin: false }
    ];
    for (const { file, userId, isAdmin } of cases) {
      assert.equal(
        canViewFileContent(file, userId, isAdmin),
        canListFileWithoutTask(file, userId, isAdmin),
        `查看与列表权限必须一致：${JSON.stringify({ file, userId, isAdmin })}`
      );
    }
  });
});

describe('canDeleteFile（删除文件）', () => {
  it('管理员可以删除任意人上传的文件', () => {
    assert.equal(canDeleteFile({ ownerId: OTHER_ID }, ADMIN_ID, true), true);
    assert.equal(canDeleteFile({ ownerId: MEMBER_ID }, ADMIN_ID, true), true);
  });

  it('普通成员只能删除自己上传的文件', () => {
    assert.equal(canDeleteFile({ ownerId: MEMBER_ID }, MEMBER_ID, false), true);
    assert.equal(canDeleteFile({ ownerId: OTHER_ID }, MEMBER_ID, false), false);
  });

  it('管理员删除自己的文件同样允许（不因角色走特殊分支而漏掉）', () => {
    assert.equal(canDeleteFile({ ownerId: ADMIN_ID }, ADMIN_ID, true), true);
  });

  it('历史文件没有 ownerId 时：管理员可清理，普通成员不可删除', () => {
    const legacy = { ownerId: undefined };
    assert.equal(canDeleteFile(legacy, ADMIN_ID, true), true);
    assert.equal(canDeleteFile(legacy, MEMBER_ID, false), false);
  });
});
