import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from './range.ts';

/**
 * HTTP Range 解析测试
 *
 * 覆盖 RFC 7233 的各种边界：
 *   - 正常区间 / 开放区间 / 后缀区间
 *   - end 超出文件大小（应截断而不是报错）
 *   - start 越界 / 空文件（应 416）
 *   - 非法格式（应降级为全量 200）
 *
 * 运行：npm test
 */

const FILE_SIZE = 1000;

describe('parseRange - 完整文件', () => {
  it('没有 Range 头时返回完整文件', () => {
    assert.deepEqual(parseRange(undefined, FILE_SIZE), { status: 'full' });
    assert.deepEqual(parseRange(null, FILE_SIZE), { status: 'full' });
    assert.deepEqual(parseRange('', FILE_SIZE), { status: 'full' });
  });

  it('格式非法时降级为完整文件（而不是报错）', () => {
    assert.deepEqual(parseRange('bytes=abc', FILE_SIZE), { status: 'full' });
    assert.deepEqual(parseRange('items=0-10', FILE_SIZE), { status: 'full' });
    assert.deepEqual(parseRange('bytes=-', FILE_SIZE), { status: 'full' });
    // 多段 Range 不支持，按规范可忽略
    assert.deepEqual(parseRange('bytes=0-99,200-299', FILE_SIZE), { status: 'full' });
  });
});

describe('parseRange - 正常区间', () => {
  it('bytes=0-99 取前 100 字节', () => {
    assert.deepEqual(parseRange('bytes=0-99', FILE_SIZE), {
      status: 'partial',
      start: 0,
      end: 99
    });
  });

  it('bytes=100-199 取中间一段', () => {
    assert.deepEqual(parseRange('bytes=100-199', FILE_SIZE), {
      status: 'partial',
      start: 100,
      end: 199
    });
  });

  it('bytes=999-999 取最后一个字节', () => {
    assert.deepEqual(parseRange('bytes=999-999', FILE_SIZE), {
      status: 'partial',
      start: 999,
      end: 999
    });
  });

  it('前后有空格也能解析', () => {
    assert.deepEqual(parseRange('  bytes=0-9  ', FILE_SIZE), {
      status: 'partial',
      start: 0,
      end: 9
    });
  });
});

describe('parseRange - 开放区间', () => {
  it('bytes=900- 取到文件末尾', () => {
    assert.deepEqual(parseRange('bytes=900-', FILE_SIZE), {
      status: 'partial',
      start: 900,
      end: 999
    });
  });

  it('bytes=0- 取整个文件', () => {
    assert.deepEqual(parseRange('bytes=0-', FILE_SIZE), {
      status: 'partial',
      start: 0,
      end: 999
    });
  });
});

describe('parseRange - 后缀区间（bytes=-N）', () => {
  it('bytes=-100 取最后 100 字节', () => {
    assert.deepEqual(parseRange('bytes=-100', FILE_SIZE), {
      status: 'partial',
      start: 900,
      end: 999
    });
  });

  it('bytes=-99999 超过文件大小，返回整个文件', () => {
    assert.deepEqual(parseRange('bytes=-99999', FILE_SIZE), {
      status: 'partial',
      start: 0,
      end: 999
    });
  });

  it('bytes=-0 无法满足', () => {
    assert.deepEqual(parseRange('bytes=-0', FILE_SIZE), {
      status: 'unsatisfiable',
      fileSize: FILE_SIZE
    });
  });
});

describe('parseRange - 边界截断', () => {
  it('end 超出文件大小时截断到文件末尾，不报错', () => {
    assert.deepEqual(parseRange('bytes=900-99999', FILE_SIZE), {
      status: 'partial',
      start: 900,
      end: 999
    });
  });
});

describe('parseRange - 无法满足（416）', () => {
  it('start 等于文件大小（越界）', () => {
    assert.deepEqual(parseRange('bytes=1000-1099', FILE_SIZE), {
      status: 'unsatisfiable',
      fileSize: FILE_SIZE
    });
  });

  it('start 大于 end', () => {
    assert.deepEqual(parseRange('bytes=500-100', FILE_SIZE), {
      status: 'unsatisfiable',
      fileSize: FILE_SIZE
    });
  });

  it('空文件下任何 Range 都无法满足', () => {
    assert.deepEqual(parseRange('bytes=0-0', 0), {
      status: 'unsatisfiable',
      fileSize: 0
    });
  });
});
