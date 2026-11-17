/**
 * 扩展名 → MIME 类型映射（视频 / 音频 / 图片 / PDF / 文本）
 *
 * 为什么需要这个文件：
 *   下载接口以前统一返回 application/octet-stream + Content-Disposition: attachment，
 *   浏览器拿到这种响应只会「弹下载框」，绝不会内联播放。
 *   <video src="..."> 想直接播放，服务端必须做两件事：
 *     1. Content-Type 给成真实类型（video/mp4）；
 *     2. Content-Disposition 用 inline（attachment 会强制下载）。
 *   两者缺一，视频就是「查看失败 / 无法播放」，这是本次修复的核心。
 *
 * 口径与前端 frontend/src/utils/filePreview.ts 的 getBlobMime 保持一致，
 * 改这里时记得同步那边（反之亦然），否则「预览」和「下载」两条链路行为会不一致。
 */

const MIME_MAP: Record<string, string> = {
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  // 视频
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  // 音频
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  // 文档 / 文本
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yml: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8',
  js: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  css: 'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  conf: 'text/plain; charset=utf-8'
}

/** 这些类型浏览器能安全内联渲染（不会执行脚本），可以放心用 inline */
const INLINE_SAFE_KINDS = ['image/', 'video/', 'audio/', 'text/', 'application/pdf', 'application/json']

/** 取小写扩展名（没有扩展名返回空串），规则与前端 getFileExt 一致 */
export function getFileExt(fileName: string): string {
  const name = (fileName || '').trim()
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** 按文件名推断 MIME，未知类型回退 application/octet-stream */
export function getMimeType(fileName: string): string {
  return MIME_MAP[getFileExt(fileName)] || 'application/octet-stream'
}

/**
 * 该类型是否允许内联展示。
 * 只对白名单前缀放行：像 .html 这种如果按 text/html 返回，内联会执行脚本（XSS），
 * 所以映射表里刻意把它们归到了 text/plain。
 */
export function isInlineSafe(mime: string): boolean {
  return INLINE_SAFE_KINDS.some((prefix) => mime.startsWith(prefix))
}
