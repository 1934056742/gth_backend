// ============================================================
// 文件分类接口 - 列表 / 新建 / 修改 / 删除（仅管理员）
// 说明：与 upload.ts 一样，对外暴露 registerCategoryRoutes(app)，
//       在 index.ts 里调用一次即可把下面所有接口挂到 app 上。
// 名称唯一：schema 里 name 加了 @unique，这里再先查重，
//          以便返回 400 + 明确文案（而不是数据库原始的唯一约束报错）。
// ============================================================
import type { Express, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import { authMiddleware, type AuthRequest } from './auth';

type CategoryInput = { name?: unknown };

/** 取出并规范化分类名称：去首尾空格，非字符串一律当空处理 */
function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 注册文件分类相关接口
 * @param app      Express 应用实例
 * @param prisma   Prisma 客户端（复用 index.ts 里的同一个实例）
 */
export function registerCategoryRoutes(app: Express, prisma: PrismaClient) {
  /**
   * 管理员校验
   * 返回 true 表示已放行；返回 false 表示已写入 401/403 响应，调用方直接 return
   */
  async function ensureAdmin(req: AuthRequest, res: Response): Promise<boolean> {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: '未登录' });
      return false;
    }
    const currentUser = await prisma.user.findFirst({ where: { id: userId } });
    if (currentUser?.role !== 'admin') {
      res.status(403).json({ error: '仅管理员可以维护文件分类' });
      return false;
    }
    return true;
  }

  // ---------- 分类列表 ----------
  // 前端调用：GET /api/categories
  app.get('/api/categories', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      if (!(await ensureAdmin(req, res))) return;
      const list = await prisma.fileCategory.findMany({
        orderBy: { createdAt: 'desc' }
      });
      res.json(list);
    } catch (error) {
      res.status(500).json({ error: '查询分类失败' });
    }
  });

  // ---------- 分类下拉选项（所有登录用户可读） ----------
  // 上传文件时必须选择分类，普通成员也要能读到候选项，所以这里不校验管理员
  // 前端调用：GET /api/categoryOptions
  app.get('/api/categoryOptions', authMiddleware, async (_req: AuthRequest, res: Response) => {
    try {
      const list = await prisma.fileCategory.findMany({
        orderBy: { createdAt: 'desc' }
      });
      res.json(list);
    } catch (error) {
      res.status(500).json({ error: '查询分类失败' });
    }
  });

  // ---------- 新建分类 ----------
  // 前端调用：POST /api/categories，body 传 { name }
  app.post('/api/categories', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      if (!(await ensureAdmin(req, res))) return;

      const name = normalizeName((req.body as CategoryInput)?.name);
      if (!name) {
        return res.status(400).json({ error: '分类名称不能为空' });
      }

      // 名称查重（忽略首尾空格造成的不一致）
      const existing = await prisma.fileCategory.findFirst({ where: { name } });
      if (existing) {
        return res.status(400).json({ error: '分类名称已存在' });
      }

      const created = await prisma.fileCategory.create({ data: { name } });
      res.json(created);
    } catch (error) {
      // 并发下仍可能撞数据库唯一索引（P2002），兜底给出同样的友好文案
      if ((error as { code?: string })?.code === 'P2002') {
        return res.status(400).json({ error: '分类名称已存在' });
      }
      res.status(500).json({ error: '新建分类失败' });
    }
  });

  // ---------- 修改分类 ----------
  // 前端调用：PUT /api/categories/:id，body 传 { name }
  app.put('/api/categories/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      if (!(await ensureAdmin(req, res))) return;

      const id = parseInt(String((req as Request).params.id));
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: '分类 id 不合法' });
      }

      const name = normalizeName((req.body as CategoryInput)?.name);
      if (!name) {
        return res.status(400).json({ error: '分类名称不能为空' });
      }

      const existing = await prisma.fileCategory.findFirst({ where: { id } });
      if (!existing) {
        return res.status(404).json({ error: '分类不存在' });
      }

      // 改名判重：排除自己，避免"改成和原来一样的名字"被判为重复
      const duplicated = await prisma.fileCategory.findFirst({
        where: { name, id: { not: id } }
      });
      if (duplicated) {
        return res.status(400).json({ error: '分类名称已存在' });
      }

      const updated = await prisma.fileCategory.update({
        where: { id },
        data: { name }
      });
      res.json(updated);
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        return res.status(400).json({ error: '分类名称已存在' });
      }
      res.status(500).json({ error: '修改分类失败' });
    }
  });

  // ---------- 删除分类 ----------
  // 前端调用：DELETE /api/categories/:id
  app.delete('/api/categories/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
      if (!(await ensureAdmin(req, res))) return;

      const id = parseInt(String((req as Request).params.id));
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: '分类 id 不合法' });
      }

      const existing = await prisma.fileCategory.findFirst({ where: { id } });
      if (!existing) {
        return res.status(404).json({ error: '分类不存在' });
      }

      await prisma.fileCategory.delete({ where: { id } });
      res.json({ message: '删除成功' });
    } catch (error) {
      res.status(500).json({ error: '删除分类失败' });
    }
  });
}
