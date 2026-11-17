import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePageParams,
  isPaginated,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX
} from './pagination.ts';

/**
 * 分页参数解析测试
 *
 * 规则来源：src/pagination.ts
 *   - page 非法（非数字 / 0 / 负数）→ 1
 *   - pageSize 非法或未传 → 默认条数
 *   - pageSize 超过上限 → 截断到上限
 *   - skip = (page - 1) * pageSize，直接给 Prisma 用
 *
 * 设计要点：非法参数一律兜底不报错，避免前端传错一个值就让整页 500。
 */
describe('isPaginated', () => {
  it('没传 page 时返回 false，接口保持返回全部的老行为', () => {
    assert.equal(isPaginated(undefined), false);
    assert.equal(isPaginated(null), false);
    assert.equal(isPaginated(''), false);
  });

  it('传了 page（含 0）都算开启分页，由 parsePageParams 兜底修正', () => {
    assert.equal(isPaginated('1'), true);
    assert.equal(isPaginated(1), true);
    assert.equal(isPaginated('0'), true);
    assert.equal(isPaginated(['2']), true);
  });
});

describe('parsePageParams', () => {
  it('正常参数按传入值解析', () => {
    const result = parsePageParams('3', '20');
    assert.deepEqual(result, { page: 3, pageSize: 20, skip: 40, take: 20 });
  });

  it('pageSize 没传时使用默认条数', () => {
    const result = parsePageParams('1', undefined);
    assert.equal(result.pageSize, PAGE_SIZE_DEFAULT);
    assert.equal(result.take, PAGE_SIZE_DEFAULT);
  });

  it('可指定接口自己的默认条数', () => {
    assert.equal(parsePageParams('1', undefined, 5).pageSize, 5);
  });

  it('page 非法值兜底为 1', () => {
    for (const bad of ['abc', '', undefined, null, '-3', '0', '1.9abc']) {
      assert.equal(parsePageParams(bad, '10').page, 1, `page=${String(bad)}`);
    }
  });

  it('page 是小数时向下取整', () => {
    assert.equal(parsePageParams('2.9', '10').page, 2);
  });

  it('pageSize 非法值兜底为默认条数', () => {
    for (const bad of ['abc', '', undefined, null, '0', '-5']) {
      assert.equal(
        parsePageParams('1', bad).pageSize,
        PAGE_SIZE_DEFAULT,
        `pageSize=${String(bad)}`
      );
    }
  });

  it('pageSize 超过上限时截断到上限', () => {
    assert.equal(parsePageParams('1', '999999').pageSize, PAGE_SIZE_MAX);
    assert.equal(parsePageParams('1', '999999').take, PAGE_SIZE_MAX);
  });

  it('查询串传数组时只取第一个值（?page=2&page=3）', () => {
    assert.equal(parsePageParams(['2', '3'], ['5', '9']).page, 2);
    assert.equal(parsePageParams(['2', '3'], ['5', '9']).pageSize, 5);
  });

  it('skip 按页码正确偏移', () => {
    assert.equal(parsePageParams('1', '10').skip, 0);
    assert.equal(parsePageParams('2', '10').skip, 10);
    assert.equal(parsePageParams('5', '25').skip, 100);
  });
});
