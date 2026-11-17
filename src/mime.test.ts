import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFileExt, getMimeType, isInlineSafe } from './mime.ts';

/**
 * 文件类型 → MIME 映射测试
 *
 * 背景：下载接口以前统一返回 application/octet-stream + attachment，
 *      导致 <video> 拿到响应后无法播放（本次修复的直接原因）。
 *      这里锁住三件事：
 *        1. 视频/音频/图片/PDF 必须映射到浏览器能解码的真实类型；
 *        2. 未知类型回退到 octet-stream（不能被内联渲染）；
 *        3. 危险类型（html/svg 之外的脚本类）不能按可执行类型返回，防止内联 XSS。
 *
 * 运行：npm test
 */

describe('getFileExt', () => {
  it('普通扩展名转小写', () => {
    assert.equal(getFileExt('lidong.MP4'), 'mp4');
    assert.equal(getFileExt('a.JpEg'), 'jpeg');
  });

  it('多级扩展名只取最后一段', () => {
    assert.equal(getFileExt('archive.tar.gz'), 'gz');
  });

  it('没有扩展名返回空串', () => {
    assert.equal(getFileExt('README'), '');
    assert.equal(getFileExt(''), '');
  });

  it('以点开头的隐藏文件不当作扩展名', () => {
    assert.equal(getFileExt('.gitignore'), '');
  });
});

describe('getMimeType', () => {
  it('视频类型必须是浏览器能直接解码的 MIME', () => {
    // 这是本次「MP4 查看失败」问题的核心断言：
    // 只要这里返回 video/mp4，<video src> 才能播放
    assert.equal(getMimeType('lidong.mp4'), 'video/mp4');
    assert.equal(getMimeType('a.m4v'), 'video/mp4');
    assert.equal(getMimeType('a.webm'), 'video/webm');
    assert.equal(getMimeType('a.mov'), 'video/quicktime');
  });

  it('音频类型', () => {
    assert.equal(getMimeType('a.mp3'), 'audio/mpeg');
    assert.equal(getMimeType('a.wav'), 'audio/wav');
    assert.equal(getMimeType('a.m4a'), 'audio/mp4');
  });

  it('图片与 PDF', () => {
    assert.equal(getMimeType('a.png'), 'image/png');
    assert.equal(getMimeType('a.jpg'), 'image/jpeg');
    assert.equal(getMimeType('a.svg'), 'image/svg+xml');
    assert.equal(getMimeType('a.pdf'), 'application/pdf');
  });

  it('文本类带上 charset，避免中文乱码', () => {
    assert.equal(getMimeType('a.txt'), 'text/plain; charset=utf-8');
    assert.equal(getMimeType('a.json'), 'application/json; charset=utf-8');
  });

  it('html 不能按可执行类型返回（防止内联 XSS）', () => {
    // 如果返回 text/html，iframe 内联会执行上传者写的脚本
    assert.equal(getMimeType('evil.html'), 'text/plain; charset=utf-8');
  });

  it('未知类型回退为 octet-stream', () => {
    assert.equal(getMimeType('a.zip'), 'application/octet-stream');
    assert.equal(getMimeType('noext'), 'application/octet-stream');
  });
});

describe('isInlineSafe', () => {
  it('图片/视频/音频/文本/PDF 允许内联', () => {
    assert.equal(isInlineSafe('video/mp4'), true);
    assert.equal(isInlineSafe('audio/mpeg'), true);
    assert.equal(isInlineSafe('image/png'), true);
    assert.equal(isInlineSafe('application/pdf'), true);
    assert.equal(isInlineSafe('text/plain; charset=utf-8'), true);
  });

  it('octet-stream 不允许内联（必须下载）', () => {
    assert.equal(isInlineSafe('application/octet-stream'), false);
  });
});
