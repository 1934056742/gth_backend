/**
 * 文件可见性 / 删除权限判定（纯函数，无副作用）
 *
 * 抽成独立模块的原因：
 *   1. 列表接口和删除接口需要完全一致的规则，集中一处避免两处漂移；
 *   2. 纯函数便于单元测试（upload.ts 内部依赖 express / fs，不便在测试里整体加载）。
 *
 * 业务背景：
 *   「文件上传」页是管理员专属后台视图（前端路由 meta.role = admin），
 *   管理员需要能查看、下载并删除【任意人】上传的文件；
 *   而「任务详情」页普通成员也能进入，成员只能删除自己上传的文件。
 *
 * 安全性：
 *   不属于自己的文件，后端统一返回 404（而非 403），避免暴露文件是否存在。
 */

/** 判定所需的最小文件信息：只需要归属人 */
export interface FileOwnerLike {
  ownerId?: number | undefined;
}

/**
 * 不带 taskId 的列表可见性（文件上传页的管理视图）：
 * 管理员看到全部文件，普通成员只看自己的。
 *
 * ownerId 在历史数据里可能缺失（早期上传的文件没有归属人），
 * 此时 `undefined === 用户id` 恒为 false，即普通成员看不到、管理员能看到，符合预期。
 */
export function canListFileWithoutTask(
  file: FileOwnerLike,
  userId: number,
  isAdmin: boolean
): boolean {
  return isAdmin || file.ownerId === userId;
}

/**
 * 查看权限：管理员可查看任意文件的内容；普通成员只能查看自己上传的。
 *
 * 与 canListFileWithoutTask 规则一致 —— 能出现在列表里，就一定能打开看；
 * 列表看不到的（别人的文档），打开时拿到 404，避免直接改 URL 越权读取。
 */
export function canViewFileContent(
  file: FileOwnerLike,
  userId: number,
  isAdmin: boolean
): boolean {
  return isAdmin || file.ownerId === userId;
}

/**
 * 删除权限：管理员可删除任意文件；普通成员只能删除自己上传的。
 *
 * ownerId 缺失时同理：普通成员删不掉，管理员可以清理这类历史遗留文件。
 */
export function canDeleteFile(
  file: FileOwnerLike,
  userId: number,
  isAdmin: boolean
): boolean {
  return isAdmin || file.ownerId === userId;
}
