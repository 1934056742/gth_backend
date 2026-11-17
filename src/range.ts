/**
 * HTTP Range 请求头解析（大文件断点续传 / 分段下载）
 *
 * 只处理单段 Range（"bytes=start-end" 形式），这也是浏览器与大多数下载工具用的形式。
 * 多段 Range（"bytes=0-99,200-299"）需要返回 multipart/byteranges，实现复杂且很少被使用，
 * 这里按 RFC 7233 允许的方式忽略它，退化为 200 全量返回。
 *
 * 规范要点（RFC 7233）：
 *   - bytes=0-99        → 前 100 字节
 *   - bytes=100-        → 从 100 到文件末尾
 *   - bytes=-500        → 最后 500 字节（suffix range）
 *   - end 超出文件大小时，截断到 fileSize - 1，不报错
 *   - start >= fileSize 或 start > end → 416 Range Not Satisfiable
 */

export type RangeResult =
  | { status: 'full' }
  | { status: 'partial'; start: number; end: number }
  | { status: 'unsatisfiable'; fileSize: number }

export function parseRange(
  rangeHeader: string | undefined | null,
  fileSize: number
): RangeResult {
  // 没有 Range 头或格式不对 → 返回完整文件
  if (!rangeHeader) return { status: 'full' }

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim())
  if (!match) return { status: 'full' }

  const startText = match[1] || ''
  const endText = match[2] || ''
  // "bytes=-" 两个数字都缺 → 非法，按规范忽略（返回全量）
  if (!startText && !endText) return { status: 'full' }

  // 空文件下任何 Range 都无法满足
  if (fileSize === 0) {
    return { status: 'unsatisfiable', fileSize }
  }

  let start: number
  let end: number

  if (!startText) {
    // bytes=-N：最后 N 字节
    const suffixLength = parseInt(endText, 10)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { status: 'unsatisfiable', fileSize }
    }
    start = Math.max(fileSize - suffixLength, 0)
    end = fileSize - 1
  } else {
    start = parseInt(startText, 10)
    end = endText ? Math.min(parseInt(endText, 10), fileSize - 1) : fileSize - 1
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { status: 'full' }
  }
  // start 越界 或 start > end → 416
  if (start >= fileSize || start > end || start < 0) {
    return { status: 'unsatisfiable', fileSize }
  }

  return { status: 'partial', start, end }
}
