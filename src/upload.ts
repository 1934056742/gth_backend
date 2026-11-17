// ============================================================
// 大文件分片上传模块
// 提供：秒传校验 / 分片上传 / 分片合并 / 文件列表 / 文件下载 / 文件删除
// 设计说明：
//   1. 不引入第三方 multer，使用 express.raw 读取请求体后自行解析 multipart；
//   2. 每个文件按 fileHash 建立独立的分片目录，分片文件名为 `${index}`；
//   3. 所有分片到齐后自动合并为最终文件（最后一片上传完即返回 url）；
//   4. 已上传文件信息保存在 uploads/files.json（无数据库依赖，重启不丢）；
//   5. 全部接口都要求登录（authMiddleware）；文件默认可按 ownerId 隔离，
//      但当按 taskId 查询 / 访问挂在任务下的文件时，同一任务对参与者可见
//      （管理员见全部任务，成员见自己的任务），用于任务详情页跨人查看附件；
//      删除接口仍然只允许删除自己上传的文件，避免越权清理他人数据。
//      下载走 GET /api/upload/files/:id/download，必须带 token，静态目录不再对外暴露 files/。
// ============================================================

import express from 'express';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { authMiddleware, authMiddlewareWithQueryToken, type AuthRequest } from './auth';
import { parseRange } from './range';
import { getMimeType, isInlineSafe } from './mime';
import { canListFileWithoutTask, canDeleteFile } from './uploadPermission';

// ---------- 存储目录 ----------
// 所有上传内容放在 backend/uploads 下（分片临时目录 + 最终文件）
const UPLOAD_ROOT = path.resolve(__dirname, '..', 'uploads');
const CHUNK_ROOT = path.join(UPLOAD_ROOT, 'chunks');
const FILE_ROOT = path.join(UPLOAD_ROOT, 'files');
const META_FILE = path.join(UPLOAD_ROOT, 'files.json');
// 对外访问路径的前缀，静态目录在此模块内挂载
export const UPLOAD_STATIC_PATH = '/uploads';

// 单个分片最大大小（前端可选 1/5/10/20/50MB，这里放宽到 64MB，可用环境变量调整）
const MAX_CHUNK_SIZE = Number(process.env.UPLOAD_MAX_CHUNK_SIZE || 64 * 1024 * 1024);

// 僵尸分片目录的存活时间（默认 24 小时）：用户上传一半后彻底放弃，分片会永久占磁盘。
// 通过定时任务清理，避免 uploads/chunks 无限膨胀。可用环境变量调整。
const ORPHAN_CHUNK_TTL = Number(process.env.UPLOAD_ORPHAN_TTL_MS || 24 * 60 * 60 * 1000);
// 清理任务的执行间隔（默认 1 小时）
const CLEANUP_INTERVAL = Number(process.env.UPLOAD_CLEANUP_INTERVAL_MS || 60 * 60 * 1000);
// 合并分片时每次读写的块大小（默认 1MB）：块越大系统调用越少，块越小内存占用越低
const READ_BLOCK = Number(process.env.UPLOAD_MERGE_BLOCK || 1024 * 1024);

// 文件元数据（id 自增）
interface FileMeta {
  id: number;
  fileHash: string;
  fileName: string;
  fileSize: number;
  url: string;
  createdAt: string;
  // 文件归属用户（鉴权中间件解析出的 userId），旧数据可能为空
  ownerId?: number;
  // 上传人姓名（冗余快照：用户后来改名了，历史文件上仍显示当时的姓名）
  uploaderName?: string | undefined;
  // 上传人账号（快照）：uploaderName 为空（老数据）时用它兜底展示
  uploaderAccount?: string | undefined;
  // 文件分类（FileCategory.id）
  categoryId?: number | undefined;
  // 所属任务（Task.id）
  taskId?: number | undefined;
}

/**
 * 上传时必填的业务归属信息：分类 + 任务
 * 上传人不需要前端传，由后端从 token 里解析，避免伪造
 */
interface FileOwnership {
  categoryId: number;
  taskId: number;
}

// 上传任务状态（分片进度以磁盘为准，这里做缓存）
interface UploadState {
  fileName: string;
  fileSize: number;
  totalChunks: number;
  received: Set<number>;
  // 该分片目录的归属用户：防止他人拿到 fileHash 后往里塞分片或触发合并
  ownerId?: number;
  // 最近一次活动时间（用于清理僵尸分片目录）
  lastActiveAt?: number;
}

const uploadStates = new Map<string, UploadState>();
let fileMetas: FileMeta[] = [];
let metaLoaded = false;

// ---------- 工具函数 ----------

// 只允许字母、数字、下划线、中划线，防止路径穿越
function safeHash(hash: string) {
  return /^[a-zA-Z0-9_-]{16,128}$/.test(hash) ? hash : '';
}

// 去掉文件名中的路径部分与危险字符
function safeFileName(name: string) {
  const base = path.basename(name || 'unnamed').replace(/[\\/:*?"<>|]/g, '_');
  return base.slice(0, 180) || 'unnamed';
}

function chunkDir(hash: string) {
  return path.join(CHUNK_ROOT, hash);
}

function chunkFile(hash: string, index: number) {
  return path.join(chunkDir(hash), String(index));
}

// 元数据只读取一次，之后以内存为准
async function loadMetas() {
  if (metaLoaded) return;
  metaLoaded = true;
  try {
    const raw = await fs.readFile(META_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) fileMetas = parsed as FileMeta[];
  } catch {
    fileMetas = [];
  }
}

async function saveMetas() {
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
  await fs.writeFile(META_FILE, JSON.stringify(fileMetas, null, 2), 'utf-8');
}

// 判断文件是否存在
async function exists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 分片目录归属（防越权） ---------------- */

// 分片目录归属记录：{ [fileHash]: ownerId }
// 单独存一个文件，避免每次校验都要遍历整个分片目录。
const CHUNK_OWNER_FILE = path.join(UPLOAD_ROOT, 'chunk-owners.json');
let chunkOwners: Record<string, number> = {};
let chunkOwnersLoaded = false;

async function loadChunkOwners() {
  if (chunkOwnersLoaded) return;
  chunkOwnersLoaded = true;
  try {
    const raw = await fs.readFile(CHUNK_OWNER_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      chunkOwners = parsed as Record<string, number>;
    }
  } catch {
    chunkOwners = {};
  }
}

async function saveChunkOwners() {
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
  await fs.writeFile(CHUNK_OWNER_FILE, JSON.stringify(chunkOwners, null, 2), 'utf-8');
}

/**
 * 认领（或校验）某个 fileHash 的分片目录归属。
 *
 * 背景：分片目录以 fileHash 命名，而 fileHash 是可预测的（等于文件内容摘要）。
 *       如果不校验归属，攻击者只要拿到别人的 fileHash，就能：
 *         1. 往上写伪造分片，污染别人正在合并的文件；
 *         2. 直接调 /merge 接口，把别人的半成品合并成自己的文件。
 *
 * 规则：
 *   - 目录首次被使用时，由第一个访问者认领；
 *   - 已有归属者时，只允许原归属者继续操作，其他人返回 403。
 *
 * @returns true 表示校验通过（或成功认领）
 */
async function claimChunkDir(
  fileHash: string,
  ownerId: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
  await loadChunkOwners();
  const current = chunkOwners[fileHash];
  if (current === undefined) {
    chunkOwners[fileHash] = ownerId;
    await saveChunkOwners();
    return { ok: true };
  }
  if (current !== ownerId) {
    return { ok: false, reason: '无权操作该分片目录' };
  }
  return { ok: true };
}

// 合并完成后释放归属记录
async function releaseChunkOwner(fileHash: string) {
  await loadChunkOwners();
  if (chunkOwners[fileHash] !== undefined) {
    delete chunkOwners[fileHash];
    await saveChunkOwners();
  }
}

/* ---------------- 僵尸分片清理 ---------------- */

/**
 * 清理长时间未活动的分片目录。
 *
 * 为什么需要：
 *   分片是"边传边落盘"的中间产物。用户传一半关掉页面、或彻底放弃，
 *   这些分片就永远不会被合并，但会一直占着磁盘。大文件场景下（GB 级）
 *   几个这样的残留就能吃掉大量空间，必须有兜底回收策略。
 *
 * 判定依据（取两者中最近的时间，避免误删正在上传的目录）：
 *   1. 目录的 mtime（分片文件写入会刷新父目录的 mtime）；
 *   2. 内存里的 lastActiveAt（服务运行期间的活动记录）。
 *
 * @param ttlMs 存活时间，超过则删除
 * @returns 删除的目录数量与被释放的字节数
 */
export async function cleanupOrphanChunks(ttlMs = ORPHAN_CHUNK_TTL) {
  const now = Date.now();
  let removedDirs = 0;
  let freedBytes = 0;
  let names: string[];
  try {
    names = await fs.readdir(CHUNK_ROOT);
  } catch {
    // 目录不存在说明还没人上传过
    return { removedDirs, freedBytes };
  }

  for (const name of names) {
    const dir = path.join(CHUNK_ROOT, name);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;

      const state = uploadStates.get(name);
      const lastActive = Math.max(stat.mtimeMs, state?.lastActiveAt || 0);
      // 仍在保留期内 → 跳过（用户可能只是暂时离开）
      if (now - lastActive < ttlMs) continue;

      // 统计占用大小后再删除，便于日志观察回收效果
      const files = await fs.readdir(dir);
      for (const file of files) {
        try {
          const fileStat = await fs.stat(path.join(dir, file));
          freedBytes += fileStat.size;
        } catch {
          /* 统计失败不影响清理 */
        }
      }

      await fs.rm(dir, { recursive: true, force: true });
      uploadStates.delete(name);
      await releaseChunkOwner(name);
      removedDirs += 1;
    } catch (error) {
      console.error(`清理分片目录失败 ${name}:`, error);
    }
  }

  if (removedDirs > 0) {
    console.log(
      `[upload] 已清理 ${removedDirs} 个僵尸分片目录，释放 ${(freedBytes / 1024 / 1024).toFixed(2)} MB`
    );
  }
  return { removedDirs, freedBytes };
}

// 定时清理句柄（防止重复注册）
let cleanupTimer: NodeJS.Timeout | undefined;

/**
 * 启动定时清理任务（由 registerUploadRoutes 调用一次即可）
 * 用 unref() 让定时器不阻塞进程退出。
 */
export function startChunkCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    void cleanupOrphanChunks();
  }, CLEANUP_INTERVAL);
  cleanupTimer.unref?.();
  console.log(
    `[upload] 分片清理任务已启动：间隔 ${CLEANUP_INTERVAL / 1000}s，TTL ${ORPHAN_CHUNK_TTL / 1000}s`
  );
}

// 生成新的文件 id
function nextId() {
  return fileMetas.length ? Math.max(...fileMetas.map((item) => item.id)) + 1 : 1;
}

// url 里的文件名经过 encodeURIComponent，取回磁盘文件名时要解码
function storedNameFromUrl(url: string) {
  const base = path.basename(url || '');
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

// 读取分片目录下已存在的分片下标（以磁盘为准，服务端重启也能续传）
async function readReceivedChunks(hash: string) {
  try {
    const names = await fs.readdir(chunkDir(hash));
    return names
      .filter((name) => /^\d+$/.test(name))
      .map((name) => parseInt(name, 10))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

// 获取（必要时从磁盘恢复）上传状态
async function getUploadState(hash: string): Promise<UploadState | undefined> {
  const cached = uploadStates.get(hash);
  if (cached) return cached;
  const received = await readReceivedChunks(hash);
  if (!received.length) return undefined;
  const state: UploadState = {
    fileName: '',
    fileSize: 0,
    totalChunks: 0,
    received: new Set(received)
  };
  uploadStates.set(hash, state);
  return state;
}

// 合并中的任务（同一 hash 并发到达时只合并一次，避免重复写同一文件）
// 说明：除了「正在合并」，还要记住「刚刚合并完成」的结果。
//      原因：两个请求几乎同时判定 received.size >= totalChunks 时，会并发调用本函数；
//      如果合并太快，后到的请求可能在 finally 删除记录之后才进来，于是又启动一次合并，
//      而此时分片目录已被上一次合并删掉 → 抛「分片 N 缺失」→ 接口 500。
//      因此这里缓存已完成的结果，并给一个短暂的宽限期。
const mergingTasks = new Map<string, Promise<string>>();
const mergedResults = new Map<string, { storedName: string; at: number }>();
// 已完成结果保留时长：足够覆盖同一批并发请求的后续重试
const MERGED_RESULT_TTL = 30 * 1000;

function getMergedResult(hash: string) {
  const hit = mergedResults.get(hash);
  if (!hit) return undefined;
  if (Date.now() - hit.at > MERGED_RESULT_TTL) {
    mergedResults.delete(hash);
    return undefined;
  }
  return hit.storedName;
}

// 合并分片为最终文件，成功后清理分片目录
// 说明：逐片、逐块串行读写，内存占用与 READ_BLOCK 同量级（不会把整个文件读进内存），
//      大文件（几十 GB）也不会 OOM；合并完校验总大小，防止中途异常导致文件被截断。
async function mergeChunksToFile(hash: string, state: UploadState) {
  const running = mergingTasks.get(hash);
  if (running) return running;
  // 刚合并完（可能是并发请求里的另一个）：直接复用结果，避免重复合并
  const done = getMergedResult(hash);
  if (done) return done;

  const task = (async () => {
    await fs.mkdir(FILE_ROOT, { recursive: true });
    const storedName = `${hash}_${safeFileName(state.fileName || hash)}`;
    const target = path.join(FILE_ROOT, storedName);

    // 先写临时文件，合并成功后再改名，避免下载到只写了一半的文件
    const tempTarget = `${target}.merging`;
    // 用 FileHandle 顺序追加写入：位置由 offset 显式指定，不依赖流的背压时序，
    // 也不会有「多个 pipeline 挂同一个 WriteStream」导致的监听器泄漏问题。
    const handle = await fs.open(tempTarget, 'w');
    let written = 0;

    try {
      for (let index = 0; index < state.totalChunks; index += 1) {
        const part = chunkFile(hash, index);
        let partSize: number;
        try {
          partSize = (await fs.stat(part)).size;
        } catch {
          throw new Error(`分片 ${index} 缺失，无法合并`);
        }

        // 按固定块大小逐块读入并写入，内存占用与 READ_BLOCK 同量级（大文件也不会 OOM）
        const input = await fs.open(part, 'r');
        try {
          const buffer = Buffer.allocUnsafe(Math.min(READ_BLOCK, partSize || 1));
          let readInPart = 0;
          for (;;) {
            const { bytesRead } = await input.read(buffer, 0, buffer.length, readInPart);
            if (bytesRead <= 0) break;
            await handle.write(buffer, 0, bytesRead, written);
            written += bytesRead;
            readInPart += bytesRead;
          }
        } finally {
          await input.close();
        }
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(tempTarget, { force: true }).catch(() => undefined);
      throw error;
    }

    // 关闭文件，确保所有数据真正落盘
    await handle.close();

    // 校验：合并后大小必须等于所有分片之和，否则说明数据不完整
    const mergedSize = (await fs.stat(tempTarget)).size;
    if (mergedSize !== written) {
      await fs.rm(tempTarget, { force: true }).catch(() => undefined);
      throw new Error(`合并结果不完整（${mergedSize}/${written} 字节）`);
    }

    await fs.rename(tempTarget, target);

    // 合并完成后清理分片，释放磁盘
    await fs.rm(chunkDir(hash), { recursive: true, force: true });
    uploadStates.delete(hash);

    return storedName;
  })();

  mergingTasks.set(hash, task);
  try {
    const storedName = await task;
    // 记住结果：并发请求 / 紧接着的重复请求直接复用它，不再二次合并
    mergedResults.set(hash, { storedName, at: Date.now() });
    return storedName;
  } finally {
    mergingTasks.delete(hash);
  }
}

// 合并完成后登记文件元数据
// 说明：同一份文件（fileHash）可能被同一用户挂到不同分类 / 任务下，
//      因此这里按「hash + 用户 + 分类 + 任务」去重，同一组合只保留一条。
async function saveFileMeta(
  hash: string,
  state: UploadState,
  storedName: string,
  ownerId: number,
  ownership?: FileOwnership & { uploaderName?: string; uploaderAccount?: string }
) {
  const categoryId = ownership?.categoryId;
  const taskId = ownership?.taskId;
  // 命中同一归属的旧记录时复用其 id，避免列表里出现重复行
  const previous = fileMetas.find(
    (item) =>
      item.fileHash === hash &&
      item.ownerId === ownerId &&
      item.categoryId === categoryId &&
      item.taskId === taskId
  );
  const meta: FileMeta = {
    id: previous?.id ?? nextId(),
    fileHash: hash,
    fileName: state.fileName || storedName,
    fileSize: state.fileSize,
    url: `${UPLOAD_STATIC_PATH}/files/${encodeURIComponent(storedName)}`,
    createdAt: new Date().toISOString(),
    ownerId,
    uploaderName: ownership?.uploaderName ?? previous?.uploaderName ?? '',
    uploaderAccount: ownership?.uploaderAccount ?? previous?.uploaderAccount ?? '',
    categoryId,
    taskId
  };
  fileMetas = fileMetas.filter((item) => item.id !== meta.id).concat(meta);
  await saveMetas();
  return meta;
}

// ============================================================
// 路由注册
// ============================================================
// 说明：这里需要 prisma 来校验「文件分类 / 任务」是否存在，并查出上传人姓名。
//      由于历史原因 registerUploadRoutes 的签名只有一个参数，
//      为不破坏现有调用，prisma 作为可选参数传入（不传则跳过归属校验）。
type UploadPrisma = {
  fileCategory: { findFirst: (args: any) => Promise<any> };
  task: { findFirst: (args: any) => Promise<any> };
  user: { findFirst: (args: any) => Promise<any> };
};

// ============================================================
// 文件权限判定（列表 / 删除共用）
// ============================================================
// 规则实现在 uploadPermission.ts（纯函数，可单测）；
// 这里只补一个「查角色」的辅助函数，避免每个路由各查一次库、各写一遍判断。

/** 查询当前登录人是否为管理员（prisma 未注入时按非管理员处理） */
async function isAdminUser(
  prisma: UploadPrisma | undefined,
  userId: number
): Promise<boolean> {
  if (!prisma) return false;
  const currentUser = await prisma.user.findFirst({
    where: { id: userId },
    select: { role: true }
  });
  return currentUser?.role === 'admin';
}

export function registerUploadRoutes(app: express.Express, prisma?: UploadPrisma) {
  // 启动僵尸分片清理定时任务（幂等，重复调用不会重复注册）
  startChunkCleanup();

  // 静态目录：仅用于调试查看，默认不对外暴露 files/ 目录（文件必须走带鉴权的下载接口）
  // 如需临时放开，设置环境变量 UPLOAD_STATIC_OPEN=true
  if (process.env.UPLOAD_STATIC_OPEN === 'true') {
    app.use(UPLOAD_STATIC_PATH, express.static(UPLOAD_ROOT, { index: false }));
  }

  /* ---------------- 归属信息（分类 / 任务 / 上传人）校验 ---------------- */

  /**
   * 解析并校验上传归属：分类必选、任务必选、上传人由 token 推导
   *
   * 三者的来源不同，安全性要求也不同：
   *   - categoryId / taskId 由前端提交 → 必须校验存在，否则会挂上不存在的外键；
   *   - 上传人绝不能信前端 → 一律用 authMiddleware 解析出的 req.userId 查库。
   *
   * @returns ok=false 时已经写入 400/500 响应，调用方直接 return
   */
  async function resolveOwnership(
    body: any,
    ownerId: number
  ): Promise<{ ok: true; data: FileOwnership & { uploaderName: string; uploaderAccount: string } } | { ok: false }> {
    const categoryId = parseInt(String(body?.categoryId ?? ''), 10);
    const taskId = parseInt(String(body?.taskId ?? ''), 10);
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return { ok: false };
    }
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return { ok: false };
    }
    if (!prisma) {
      // 未注入 prisma（理论上不会发生），退化为只透传 id
      return { ok: true, data: { categoryId, taskId, uploaderName: '', uploaderAccount: '' } };
    }

    const category = await prisma.fileCategory.findFirst({ where: { id: categoryId } });
    if (!category) return { ok: false };
    const task = await prisma.task.findFirst({ where: { id: taskId } });
    if (!task) return { ok: false };
    const user = await prisma.user.findFirst({ where: { id: ownerId } });
    // 姓名优先取 username（界面上的"姓名"），没填姓名时退回登录账号
    const uploaderName = String(user?.username || user?.account || '');
    const uploaderAccount = String(user?.account || '');
    return { ok: true, data: { categoryId, taskId, uploaderName, uploaderAccount } };
  }

  // 只做"是否存在"的轻量校验，用于秒传 / 合并这两个不会重新写归属信息的入口
  // ---------- 秒传 / 断点续传校验 ----------
  // POST /api/upload/check  body: { fileHash, fileName, fileSize, totalChunks, categoryId, taskId }
  // 需要登录：文件按 ownerId 隔离，只有自己的文件才会命中秒传
  // 分类 / 任务必填：同一份文件挂到不同分类或任务下，要各留一条记录（便于按任务归档统计）
  app.post('/api/upload/check', authMiddleware, async (req: AuthRequest, res) => {
    const ownerId = req.userId;
    if (!ownerId) return res.status(401).json({ error: '未登录' });
    await loadMetas();
    const fileHash = safeHash(String(req.body?.fileHash || ''));
    const totalChunks = Math.max(parseInt(String(req.body?.totalChunks || '0'), 10) || 0, 1);
    if (!fileHash) {
      return res.status(400).json({ error: 'fileHash 不合法' });
    }

    // 归属信息必填校验（分类、任务都要选，上传人由 token 决定）
    const ownership = await resolveOwnership(req.body, ownerId);
    if (!ownership.ok) {
      return res.status(400).json({ error: '请选择文件分类和所属任务' });
    }

    // 已存在完整文件 → 秒传命中
    // 注意：命中条件包含分类与任务，同一文件挂到另一个任务下不算秒传命中，
    //      需要新建一条记录（磁盘上仍是同一个文件，复制记录即可，无需重传）。
    const cached = fileMetas.filter(
      (item) => item.fileHash === fileHash && item.ownerId === ownerId
    );
    const exact = cached.find(
      (item) =>
        item.categoryId === ownership.data.categoryId && item.taskId === ownership.data.taskId
    );
    const first = cached[0];
    const diskReady = first
      ? await exists(path.join(FILE_ROOT, storedNameFromUrl(first.url)))
      : false;

    if (diskReady && exact) {
      return res.json({
        exists: true,
        uploadedChunks: Array.from({ length: totalChunks }, (_, index) => index),
        file: exact
      });
    }

    if (diskReady && !exact && first) {
      // 文件已在磁盘上，只是换了分类 / 任务：直接补一条记录，同样算秒传
      const meta: FileMeta = {
        id: nextId(),
        fileHash,
        fileName: first.fileName,
        fileSize: first.fileSize,
        url: first.url,
        createdAt: new Date().toISOString(),
        ownerId,
        uploaderName: ownership.data.uploaderName,
        categoryId: ownership.data.categoryId,
        taskId: ownership.data.taskId
      };
      fileMetas = fileMetas.concat(meta);
      await saveMetas();
      return res.json({
        exists: true,
        uploadedChunks: Array.from({ length: totalChunks }, (_, index) => index),
        file: meta
      });
    }

    // 未完成上传：返回磁盘上已有的分片，并记录元信息供合并使用
    // 认领分片目录归属（防越权：他人拿到 hash 也不能往里灌分片）
    const claim = await claimChunkDir(fileHash, ownerId);
    if (!claim.ok) {
      return res.status(403).json({ error: claim.reason });
    }

    const uploadedChunks = await readReceivedChunks(fileHash);
    const state = await getUploadState(fileHash);
    if (state) {
      state.fileName = state.fileName || String(req.body?.fileName || '');
      state.fileSize = state.fileSize || Number(req.body?.fileSize || 0);
      state.totalChunks = state.totalChunks || totalChunks;
      state.ownerId = ownerId;
      state.lastActiveAt = Date.now();
    } else {
      uploadStates.set(fileHash, {
        fileName: String(req.body?.fileName || ''),
        fileSize: Number(req.body?.fileSize || 0),
        totalChunks,
        received: new Set(uploadedChunks),
        ownerId,
        lastActiveAt: Date.now()
      });
    }

    return res.json({ exists: false, uploadedChunks });
  });

  // ---------- 上传单个分片 ----------
  // POST /api/upload/chunk  multipart/form-data
  // 字段：file（分片二进制）、fileHash、fileName、index、totalChunks、chunkSize、fileSize
  // 需要登录：Authorization 头由前端请求拦截器自动带上
  app.post(
    '/api/upload/chunk',
    authMiddleware,
    express.raw({ type: () => true, limit: MAX_CHUNK_SIZE }),
    async (req: AuthRequest, res) => {
      try {
        const ownerId = req.userId;
        if (!ownerId) return res.status(401).json({ error: '未登录' });
        await loadMetas();
        const contentType = String(req.headers['content-type'] || '');
        const { fields, file } = parseMultipart(req.body as Buffer, contentType);

        const fileHash = safeHash(fields.fileHash || '');
        if (!fileHash) {
          return res.status(400).json({ error: 'fileHash 不合法' });
        }
        if (!file || !file.length) {
          return res.status(400).json({ error: '缺少分片内容' });
        }

        const index = parseInt(fields.index || '', 10);
        const totalChunks = parseInt(fields.totalChunks || '', 10);
        if (!Number.isInteger(index) || index < 0) {
          return res.status(400).json({ error: '分片下标不合法' });
        }
        if (!Number.isInteger(totalChunks) || totalChunks < 1) {
          return res.status(400).json({ error: '分片总数不合法' });
        }

        // 落盘分片前先校验分片目录归属，防止越权写入
        const claim = await claimChunkDir(fileHash, ownerId);
        if (!claim.ok) {
          return res.status(403).json({ error: claim.reason });
        }

        // 归属信息（分类 / 任务必选，上传人来自 token）
        const ownership = await resolveOwnership({ categoryId: fields.categoryId, taskId: fields.taskId }, ownerId);
        if (!ownership.ok) {
          return res.status(400).json({ error: '请选择文件分类和所属任务' });
        }

        // 该 hash 刚刚已经合并完成（例如同一文件并发传到多个任务）：直接登记归属并返回，
        // 不再写分片、也不再合并，避免分片目录已被清空导致的 500。
        const mergedStoredName = getMergedResult(fileHash);
        if (mergedStoredName && (await exists(path.join(FILE_ROOT, mergedStoredName)))) {
          const stateForMeta: UploadState =
            uploadStates.get(fileHash) || {
              fileName: fields.fileName || '',
              fileSize: Number(fields.fileSize || 0),
              totalChunks,
              received: new Set<number>(),
              ownerId
            };
          stateForMeta.fileName = stateForMeta.fileName || fields.fileName || '';
          stateForMeta.fileSize = stateForMeta.fileSize || Number(fields.fileSize || 0);
          stateForMeta.totalChunks = totalChunks;
          stateForMeta.ownerId = ownerId;
          stateForMeta.lastActiveAt = Date.now();
          const meta = await saveFileMeta(fileHash, stateForMeta, mergedStoredName, ownerId, ownership.data);
          return res.json({ index, merged: true, url: meta.url, file: meta });
        }

        // 落盘分片
        await fs.mkdir(chunkDir(fileHash), { recursive: true });
        await fs.writeFile(chunkFile(fileHash, index), file);

        const state: UploadState = uploadStates.get(fileHash) || {
          fileName: fields.fileName || '',
          fileSize: Number(fields.fileSize || 0),
          totalChunks,
          received: new Set<number>(),
          ownerId
        };
        state.fileName = state.fileName || fields.fileName || '';
        state.fileSize = state.fileSize || Number(fields.fileSize || 0);
        state.totalChunks = totalChunks;
        state.ownerId = ownerId;
        state.lastActiveAt = Date.now();
        state.received.add(index);
        uploadStates.set(fileHash, state);

        // 分片全部到齐 → 自动合并
        // 注意：并发请求可能同时走到这里，mergeChunksToFile 内部会复用同一个合并任务，
        //      不会重复写文件；saveFileMeta 按「hash+用户+分类+任务」去重，也不会产生重复记录。
        if (state.received.size >= totalChunks) {
          const storedName = await mergeChunksToFile(fileHash, state);
          const meta = await saveFileMeta(fileHash, state, storedName, ownerId, ownership.data);
          // 合并完成，释放分片目录归属（若有其他用户秒传，仍按 hash 隔离）
          await releaseChunkOwner(fileHash);
          return res.json({ index, merged: true, url: meta.url, file: meta });
        }

        return res.json({ index, merged: false });
      } catch (error) {
        console.error('分片上传失败：', error);
        return res.status(500).json({ error: '分片上传失败' });
      }
    }
  );

  // ---------- 手动合并 ----------
  // POST /api/upload/merge  body: { fileHash, fileName, fileSize, totalChunks, categoryId, taskId }
  app.post('/api/upload/merge', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const ownerId = req.userId;
      if (!ownerId) return res.status(401).json({ error: '未登录' });
      await loadMetas();
      const fileHash = safeHash(String(req.body?.fileHash || ''));
      if (!fileHash) {
        return res.status(400).json({ error: 'fileHash 不合法' });
      }

      // 归属信息同样必填：不能借"手动合并"绕过分类 / 任务的必选校验
      const ownership = await resolveOwnership(req.body, ownerId);
      if (!ownership.ok) {
        return res.status(400).json({ error: '请选择文件分类和所属任务' });
      }

      const existing = fileMetas.find(
        (item) =>
          item.fileHash === fileHash &&
          item.ownerId === ownerId &&
          item.categoryId === ownership.data.categoryId &&
          item.taskId === ownership.data.taskId
      );
      if (existing) return res.json(existing);

      // 手动合并同样校验归属：他人不能把别人的半成品合并成自己的文件
      const claim = await claimChunkDir(fileHash, ownerId);
      if (!claim.ok) {
        return res.status(403).json({ error: claim.reason });
      }

      // 已合并完成（并发 / 重复请求）：直接登记归属返回，不再找分片
      const mergedStoredName = getMergedResult(fileHash);
      if (mergedStoredName && (await exists(path.join(FILE_ROOT, mergedStoredName)))) {
        const mergedState: UploadState = {
          fileName: String(req.body?.fileName || ''),
          fileSize: Number(req.body?.fileSize || 0),
          totalChunks: Number(req.body?.totalChunks || 0),
          received: new Set<number>(),
          ownerId,
          lastActiveAt: Date.now()
        };
        return res.json(await saveFileMeta(fileHash, mergedState, mergedStoredName, ownerId, ownership.data));
      }

      const received = await readReceivedChunks(fileHash);
      const state = (await getUploadState(fileHash)) || {
        fileName: String(req.body?.fileName || ''),
        fileSize: Number(req.body?.fileSize || 0),
        totalChunks: Number(req.body?.totalChunks || 0),
        received: new Set<number>(),
        ownerId
      };
      state.received = new Set(received);
      state.totalChunks = state.totalChunks || Number(req.body?.totalChunks || 0);
      state.ownerId = ownerId;
      state.lastActiveAt = Date.now();

      if (!state.totalChunks || state.received.size < state.totalChunks) {
        return res.status(400).json({ error: '分片不完整，无法合并', uploadedChunks: received });
      }

      const storedName = await mergeChunksToFile(fileHash, state);
      const meta = await saveFileMeta(fileHash, state, storedName, ownerId, ownership.data);
      await releaseChunkOwner(fileHash);
      return res.json(meta);
    } catch (error) {
      console.error('合并分片失败：', error);
      return res.status(500).json({ error: '合并分片失败' });
    }
  });

  /**
   * 判断当前用户能否读取某个文件（列表 / 下载 / 预览共用同一套规则）
   *
   * 规则：
   *   1. 自己上传的 → 可访问；
   *   2. 挂在某个任务下的 → 只要该任务对当前用户可见（管理员可见全部任务，
   *      普通成员只见自己的任务）就可访问，用于同一任务内跨人查看附件；
   *   3. 其他情况（没有归属任务的他人文件）→ 不可访问。
   */
  async function canAccessFile(file: FileMeta, userId: number): Promise<boolean> {
    if (file.ownerId === userId) return true;
    // 没有归属任务，无法用任务维度证明可见性
    if (!file.taskId || !prisma) return false;
    const currentUser = await (prisma as any).user.findFirst({
      where: { id: userId },
      select: { role: true }
    });
    const isAdmin = currentUser?.role === 'admin';
    const task = await (prisma as any).task.findFirst({
      where: isAdmin ? { id: file.taskId } : { id: file.taskId, userId }
    });
    return !!task;
  }

  // ---------- 文件列表 ----------
  // 查询参数（可选，用于按分类 / 任务筛选）：?categoryId=1&taskId=2
  // 返回字段在原始元数据基础上补充 categoryName / taskTitle / uploaderName，
  // 省得前端再各自拼一次映射（分类或任务已被删除时为空字符串）。
  //
  // 可见性规则（两种场景语义不同，所以分开处理）：
  //   1. 带 taskId（任务详情页的「相关文件」）：返回该任务下【所有人】上传的文件，
  //      方便管理员与成员在同一个任务里协作，此时 uploaderName 用于区分谁传的；
  //   2. 不带 taskId（文件上传页的管理视图）：
  //      - 管理员（该页面的唯一使用者）看到【全部】文件，便于统一治理 / 批量删除；
  //      - 普通成员只看自己上传的文件（按 ownerId 隔离）。
  app.get('/api/upload/files', authMiddleware, async (req: AuthRequest, res) => {
    const ownerId = req.userId;
    if (!ownerId) return res.status(401).json({ error: '未登录' });
    await loadMetas();

    // 管理员可见全部文件：文件上传页是管理员专属后台视图（前端路由已限制 role=admin），
    // 需要能看到并删除任意文件，而不只是自己上传的。
    const isAdmin = await isAdminUser(prisma, ownerId);

    // 先解析筛选参数：taskId 是否传了决定走哪种可见性
    const categoryFilter = parseInt(String(req.query.categoryId ?? ''), 10);
    const taskFilter = parseInt(String(req.query.taskId ?? ''), 10);
    const byTask = Number.isInteger(taskFilter) && taskFilter > 0;

    // 过滤掉磁盘上已不存在的文件，保证列表可信
    const result: FileMeta[] = [];
    for (const item of fileMetas) {
      // 按任务查询：走任务可见性校验（同任务下可见所有人上传的文件）；
      // 不带任务：管理员全部可见，普通成员只看自己的文件
      const visible = byTask
        ? await canAccessFile(item, ownerId)
        : canListFileWithoutTask(item, ownerId, isAdmin);
      if (!visible) continue;
      if (await exists(path.join(FILE_ROOT, storedNameFromUrl(item.url)))) result.push(item);
    }

    const filtered = result.filter(
      (item) =>
        (!Number.isInteger(categoryFilter) || item.categoryId === categoryFilter) &&
        (!Number.isInteger(taskFilter) || item.taskId === taskFilter)
    );

    // 批量取分类名与任务标题：一次性查库，避免 N+1
    let categoryMap = new Map<number, string>();
    let taskMap = new Map<number, string>();
    // 上传人兜底映射：老数据写入时还没有 uploaderName 快照，这里按 ownerId 回查姓名
    let userMap = new Map<number, string>();
    if (prisma && filtered.length) {
      const categoryIds = [...new Set(filtered.map((item) => item.categoryId).filter(Boolean))] as number[];
      const taskIds = [...new Set(filtered.map((item) => item.taskId).filter(Boolean))] as number[];
      const userIds = [
        ...new Set(
          filtered
            .filter((item) => !item.uploaderName && Number.isInteger(item.ownerId))
            .map((item) => item.ownerId as number)
        )
      ];
      const [categories, taskList, users] = await Promise.all([
        categoryIds.length
          ? (prisma as any).fileCategory.findMany({ where: { id: { in: categoryIds } } })
          : Promise.resolve([]),
        taskIds.length
          ? (prisma as any).task.findMany({ where: { id: { in: taskIds } } })
          : Promise.resolve([]),
        userIds.length
          ? (prisma as any).user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, username: true, account: true }
            })
          : Promise.resolve([])
      ]);
      categoryMap = new Map(categories.map((item: any) => [item.id, item.name]));
      taskMap = new Map(taskList.map((item: any) => [item.id, item.title]));
      userMap = new Map(
        users.map((item: any) => [item.id, String(item.username || item.account || '')])
      );
    }

    res.json(
      filtered
        .map((item) => ({
          ...item,
          categoryName: item.categoryId ? categoryMap.get(item.categoryId) || '' : '',
          taskTitle: item.taskId ? taskMap.get(item.taskId) || '' : '',
          // 上传人：优先后端快照，其次按 ownerId 回查，最后退回账号快照
          uploaderName:
            item.uploaderName ||
            (item.ownerId ? userMap.get(item.ownerId) || '' : '') ||
            item.uploaderAccount ||
            ''
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    );
  });

  // ---------- 文件下载（必须登录） ----------
  // GET /api/upload/files/:id/download
  // 支持 HTTP Range，便于大文件断点续传与进度显示；
  // 前端用 fetch 流式读取，边下边写盘，不会把整个文件读进内存。
  //
  // 权限：与列表接口保持一致——任务详情页能看到同任务下别人上传的文件，
  //      就必须能下载 / 预览，否则列表会出现"看得见、点不动"的条目。
  //      可下载 = 自己的文件 或 该文件所属任务对当前用户可见。
  app.get('/api/upload/files/:id/download', authMiddlewareWithQueryToken, async (req: AuthRequest, res) => {
    const ownerId = req.userId;
    if (!ownerId) return res.status(401).json({ error: '未登录' });
    await loadMetas();
    const id = parseInt(String(req.params.id), 10);
    const meta = fileMetas.find((item) => item.id === id);
    if (!meta || !(await canAccessFile(meta, ownerId))) {
      // 别人的文件同样返回 404，避免暴露文件是否存在
      return res.status(404).json({ error: '文件不存在' });
    }
    const storedName = storedNameFromUrl(meta.url);
    // 磁盘上的绝对路径（和上面的 meta 区分开，避免同名变量冲突）
    const filePath = path.join(FILE_ROOT, storedName);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return res.status(404).json({ error: '文件已丢失' });
    }

    const downloadName = meta.fileName || storedName;

    // ---------- 决定「内联播放」还是「附件下载」 ----------
    // 关键修复：以前这里无条件返回 octet-stream + attachment，
    // 导致 <video src> 拿到响应后直接放弃解码（表现为「查看失败/无法播放」）。
    // 现在按文件类型给真实 MIME，并默认 inline；
    // 只有显式要求下载（?download=1）或类型不安全时才用 attachment。
    const mime = getMimeType(downloadName);
    const wantsDownload = String(req.query.download ?? '') === '1';
    const disposition = wantsDownload || !isInlineSafe(mime) ? 'attachment' : 'inline';
    const encodedName = encodeURIComponent(downloadName);
    const asciiName = downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

    res.setHeader('Content-Type', mime);
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`
    );
    res.setHeader('Accept-Ranges', 'bytes');
    // 允许跨域读取响应头（开发环境走 vite 代理，生产可能跨域），
    // 否则前端既算不出下载进度，也无法判断 206。
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag');

    // ---------- 缓存协商 ----------
    // 以前是 no-store，视频每拖动一次进度条都要重新拉一遍数据，播放体验很差。
    // 这里改用「强校验 ETag + private 短缓存」：
    //   - private：鉴权资源，只允许浏览器自己缓存，禁止 CDN/代理缓存；
    //   - ETag 用 文件大小 + 修改时间 生成，文件被替换（重新上传同一 id 不会发生，
    //     但清缓存/重装后 mtime 会变）时自动失效，不需要额外存储字段；
    //   - 配合 If-Range：只要文件没变，就允许浏览器直接续传/拖动，命中缓存时返回 304。
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    // 条件请求：浏览器已有最新副本 → 304，连 1 字节都不用传
    const ifNoneMatch = req.headers['if-none-match'];
    const ifRange = req.headers['if-range'];
    // If-Range 只支持强校验的两种形式（ETag / 日期），不匹配时必须退化为 200 全量
    if (ifRange && ifRange !== etag) {
      res.removeHeader('ETag');
    }
    if (!ifRange && ifNoneMatch && ifNoneMatch === etag) {
      // 去掉正文相关头，避免 304 带 Content-Length 引起客户端困惑
      res.removeHeader('Content-Type');
      return res.status(304).end();
    }

    // 解析 Range: bytes=start-end（只处理单段，够用且实现简单）
    // 具体规则见 ./range.ts，已单独抽出以便单元测试
    const parsed = parseRange(req.headers.range, stat.size);

    if (parsed.status === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).json({ error: 'Range 超出文件范围' });
    }

    let start = 0;
    let end = stat.size - 1;
    let status = 200;

    if (parsed.status === 'partial') {
      start = parsed.start;
      end = parsed.end;
      status = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    }

    res.setHeader('Content-Length', String(end - start + 1));
    if (stat.size === 0) {
      return res.status(200).end();
    }

    // 流式发送，内存占用恒定（不一次性读入）。
    // highWaterMark 从默认 64KB 提到 1MB：大文件吞吐明显更高（每次 read 系统调用搬更多数据），
    // 代价是每个并发连接多占约 1MB 内存，对视频这种「少数长连接」场景非常划算。
    const stream = createReadStream(filePath, { start, end, highWaterMark: 1024 * 1024 });
    stream.on('error', (error) => {
      if (!res.headersSent) res.status(500).json({ error: '文件下载失败' });
      else res.destroy();
    });
    // 客户端中途取消（关闭页面/取消下载/视频拖动时播放器主动断开旧请求）时停止读取，释放文件句柄
    res.on('close', () => stream.destroy());
    return stream.pipe(res.status(status) as unknown as NodeJS.WritableStream);
  });

  // ---------- 删除文件（管理员可删任意文件，普通成员只能删自己的） ----------
  // 注意：同一份文件可能被挂到多个任务下，因而存在多条记录（id 不同、fileHash 与 url 相同）。
  //      所以这里必须先判断「磁盘文件是否还被其它记录引用」再决定要不要删物理文件，
  //      否则删掉一条记录就会把同一文件的所有记录一起变成 404。
  app.delete('/api/upload/files/:id', authMiddleware, async (req: AuthRequest, res) => {
    const ownerId = req.userId;
    if (!ownerId) return res.status(401).json({ error: '未登录' });
    await loadMetas();
    // 管理员可删除任意文件（文件上传页是管理员后台视图）；普通成员只能删除自己上传的
    const isAdmin = await isAdminUser(prisma, ownerId);
    const id = parseInt(String(req.params.id), 10);
    const meta = fileMetas.find((item) => item.id === id && canDeleteFile(item, ownerId, isAdmin));
    if (!meta) {
      // 别人的文件也返回 404，避免暴露文件是否存在
      return res.status(404).json({ error: '文件不存在' });
    }

    // 先看还有没有别的记录指向同一个磁盘文件 / 同一 fileHash（多任务、秒传共享都会命中）
    const others = fileMetas.filter((item) => item.id !== id);
    const sameStoredName = storedNameFromUrl(meta.url);
    const referencedByOther = others.some(
      (item) => item.fileHash === meta.fileHash || storedNameFromUrl(item.url) === sameStoredName
    );

    // 只删元数据记录（每次只删这一条）
    fileMetas = fileMetas.filter((item) => item.id !== id);
    await saveMetas();

    // 磁盘文件仍被其它记录引用 → 保留文件与分片，仅移除本条记录
    if (referencedByOther) {
      return res.json({
        message: '删除成功',
        removedFile: false,
        // 剩余引用数，便于前端提示 / 排查
        remaining: others.filter((item) => item.fileHash === meta.fileHash).length
      });
    }

    // 没有任何记录再引用 → 连物理文件一起清理
    await fs.rm(path.join(FILE_ROOT, sameStoredName), { force: true });
    await fs.rm(chunkDir(meta.fileHash), { recursive: true, force: true });
    uploadStates.delete(meta.fileHash);
    mergedResults.delete(meta.fileHash);
    await releaseChunkOwner(meta.fileHash);

    res.json({ message: '删除成功', removedFile: true, remaining: 0 });
  });

  // ---------- 手动触发僵尸分片清理（运维/调试用） ----------
  // POST /api/upload/cleanup  body: { ttlMs?: number }
  // 不传 ttlMs 时使用默认的 24 小时
  app.post('/api/upload/cleanup', authMiddleware, async (req: AuthRequest, res) => {
    if (!req.userId) return res.status(401).json({ error: '未登录' });
    const ttl = Number(req.body?.ttlMs);
    const result = await cleanupOrphanChunks(Number.isFinite(ttl) && ttl >= 0 ? ttl : undefined);
    res.json(result);
  });

}

// ============================================================
// multipart/form-data 解析（只处理"普通字段 + 单个文件"的简单场景）
// ============================================================
// multipart/form-data 解析（只处理"普通字段 + 单个文件"的简单场景）
// ============================================================
function parseMultipart(body: Buffer, contentType: string) {
  const fields: Record<string, string> = {};
  let file: Buffer | null = null;

  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2] || '').trim() : '';
  if (!Buffer.isBuffer(body) || !boundary) {
    return { fields, file };
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  let position = body.indexOf(delimiter);

  while (position !== -1) {
    let partStart = position + delimiter.length;
    // "--" 表示整体结束
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break;
    if (body[partStart] === 0x0d && body[partStart + 1] === 0x0a) partStart += 2;

    const nextBoundary = body.indexOf(delimiter, partStart);
    if (nextBoundary === -1) break;

    // 每个部分内容末尾带着 \r\n，需要去掉
    let partEnd = nextBoundary;
    if (body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) partEnd -= 2;

    const headerEnd = body.indexOf(headerSeparator, partStart);
    if (headerEnd !== -1 && headerEnd < partEnd) {
      const headerText = body.subarray(partStart, headerEnd).toString('utf-8');
      const content = body.subarray(headerEnd + headerSeparator.length, partEnd);
      const nameMatch = /name="([^"]*)"/i.exec(headerText);
      const name = nameMatch ? nameMatch[1] || '' : '';
      if (/filename="/i.test(headerText)) {
        if (!file) file = Buffer.from(content);
      } else if (name) {
        fields[name] = content.toString('utf-8');
      }
    }

    position = nextBoundary;
  }

  return { fields, file };
}


