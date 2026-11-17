// ============================================================
// 列表分页参数解析（抽成独立模块，方便单元测试 + 被多个路由复用）
//
// 从 index.ts 抽出来的原因和 password.ts 一样：
//   index.ts 一被 import 就会连数据库、起服务，不适合直接单测。
// 目前任务列表接口在用，后续用户列表等接口要分页可以共用。
// ============================================================

/** 默认每页条数（前端不传 pageSize 时使用） */
export const PAGE_SIZE_DEFAULT = 10
/** 单页条数上限，防止前端一次把整张表拉走 */
export const PAGE_SIZE_MAX = 100

export interface PageParams {
  page: number
  pageSize: number
  /** 直接给 Prisma 用的偏移量：(page - 1) * pageSize */
  skip: number
  take: number
}

/**
 * 解析分页参数，非法值一律兜底而不是报错。
 * @param page 查询串里的 page（req.query.page，可能是 string / string[] / undefined）
 * @param pageSize 查询串里的 pageSize
 * @param defaultPageSize 本接口的默认每页条数
 */
export function parsePageParams(
  page: unknown,
  pageSize: unknown,
  defaultPageSize: number = PAGE_SIZE_DEFAULT
): PageParams {
  // parseInt 对 undefined / '' / 'abc' 都返回 NaN，|| 后落到默认值 1
  const pageNum = Math.max(1, toInt(page) || 1)
  // 0 和负数按「没传」处理（不能用 ||，NaN 和 0 都是 falsy，但负数不是）；
  // 超过上限则截断，防止前端一次拉太多
  const sizeRaw = toInt(pageSize)
  const sizeNum = Math.min(
    PAGE_SIZE_MAX,
    sizeRaw > 0 ? sizeRaw : defaultPageSize
  )
  return {
    page: pageNum,
    pageSize: sizeNum,
    skip: (pageNum - 1) * sizeNum,
    take: sizeNum
  }
}

/** 是否开启了分页：前端没传 page 或传空串时，接口保持「返回全部」的老行为 */
export function isPaginated(page: unknown): boolean {
  return page !== undefined && page !== null && page !== ''
}

/** 把查询串参数转成整数，转不了返回 NaN（交给调用方兜底） */
function toInt(value: unknown): number {
  // 数组（?page=1&page=2）只取第一个，避免 String 后拼成 "1,2" 解析出 1
  const raw = Array.isArray(value) ? value[0] : value
  if (raw === undefined || raw === null) return NaN
  return Number.parseInt(String(raw), 10)
}
