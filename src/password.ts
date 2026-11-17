// ============================================================
// 密码规则校验（抽成独立模块，方便单元测试 + 被多个路由复用）
//
// 从 index.ts 抽出来而不是写在路由文件里，原因：
//   1. index.ts 一被 import 就会连数据库、起服务，不适合直接单测；
//   2. 修改密码接口与前端表单校验都共用同一套规则，
//      保证前后端提示文案与判定完全一致。
// ============================================================

/** 密码最短长度 */
export const PASSWORD_MIN_LENGTH = 6
/** 密码最长长度 */
export const PASSWORD_MAX_LENGTH = 32

/**
 * 校验新密码是否满足规则。
 * @param password 待校验的密码（刻意用 unknown：路由里 req.body 不可信）
 * @returns null 表示通过；返回字符串表示不通过的原因（可直接展示给前端）
 */
export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== 'string' || !password) return '新密码不能为空'
  if (password.length < PASSWORD_MIN_LENGTH) return `新密码至少 ${PASSWORD_MIN_LENGTH} 位`
  if (password.length > PASSWORD_MAX_LENGTH) return `新密码最多 ${PASSWORD_MAX_LENGTH} 位`
  // 只由数字组成 / 只由字母组成，安全强度太低，直接拦掉
  if (/^\d+$/.test(password)) return '新密码不能是纯数字，请混合字母'
  if (/^[a-zA-Z]+$/.test(password)) return '新密码不能是纯字母，请混合数字'
  if (/\s/.test(password)) return '新密码不能包含空格'
  return null
}
