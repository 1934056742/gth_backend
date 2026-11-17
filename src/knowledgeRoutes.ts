/**
 * RAG 知识库接口
 *
 *   GET    /api/knowledge/docs        文档列表（本人；管理员可见全部）
 *   GET    /api/knowledge/docs/:id    查看文档详情（解析后的正文全文，供「查看」功能使用）
 *   POST   /api/knowledge/docs        上传并建立索引（multipart，单文件）
 *   DELETE /api/knowledge/docs/:id    删除文档（切块由数据库外键级联删除）
 *   POST   /api/knowledge/search      调试用：只查不答，便于验证召回效果
 *
 * 上传为什么不用 multer：
 *   与 upload.ts 保持一致，用 express.raw 读原始 body 后自行解析 multipart
 *   （只处理「普通字段 + 单个文件」这一种形态），少一个中间件依赖。
 *
 * 支持的格式：
 *   - 纯文本类（txt/md/json/csv/... 直接按 UTF-8 解码）；
 *   - .docx（mammoth 抽纯文本）、.pdf（pdf-parse 抽文本）。
 *   两个解析库都是动态 import，只有真的上传这类文件时才加载。
 *   .doc 旧格式不支持（二进制 OLE，需先另存为 .docx）。
 *
 * 权限口径与「文件上传」页一致（复用 uploadPermission.ts 的纯函数）：
 *   管理员可查看 / 删除任意人的文档，普通成员只能操作自己的；
 *   不属于自己的文档统一返回 404，不区分「不存在」与「无权限」，避免探测。
 */

import express from 'express';
import { authMiddleware, type AuthRequest } from './auth.ts';
import { canDeleteFile, canListFileWithoutTask, canViewFileContent } from './uploadPermission.ts';
import {
  normalizeText,
  splitIntoChunks,
  tokenize,
  tokensToString,
  buildContextBlock,
  scoreChunks,
  type ChunkRecord
} from './knowledge.ts';

/** 上传上限：知识库是文本资料，10MB 足够，同时防止误传大文件拖垮内存 */
const MAX_DOC_SIZE = Number(process.env.RAG_MAX_DOC_SIZE || 10 * 1024 * 1024);
/** 文本长度上限：超过这个量级召回质量必然下降，也容易把索引写爆 */
const MAX_DOC_CHARS = Number(process.env.RAG_MAX_DOC_CHARS || 500_000);

/** 可直接按 UTF-8 当纯文本读的扩展名（与 mime.ts 的文本类保持一致） */
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'log', 'xml', 'yml', 'yaml',
  'js', 'ts', 'css', 'html', 'sql', 'ini', 'conf'
]);

/** 需要解析库抽文本的二进制格式 */
const DOC_EXTS = new Set(['docx', 'pdf']);

/** 对外暴露的支持列表（错误提示、前端提示共用同一份口径） */
export const SUPPORTED_EXTS: string[] = [...TEXT_EXTS, ...DOC_EXTS];

/** 单次查看返回的正文上限：和上传上限同量级，避免一次把超大文本塞给前端 */
export const VIEW_CONTENT_LIMIT = MAX_DOC_CHARS;

/** 说明文档为什么只支持 docx 不支持 doc */
const DOC_HINT = '.doc（Word 97-2003 旧格式）请先用 Word 另存为 .docx 再上传';

/** 路由依赖的最小 Prisma 能力（只列实际用到的 delegate，方便测试打桩） */
export interface KnowledgeRoutesPrisma {
  user: { findFirst(args: any): Promise<any | null> };
  knowledgeDoc: {
    findMany(args: any): Promise<any[]>;
    findFirst(args: any): Promise<any | null>;
    create(args: any): Promise<any>;
    delete(args: any): Promise<any>;
  };
  knowledgeChunk: {
    findMany(args: any): Promise<any[]>;
    createMany(args: any): Promise<any>;
    deleteMany(args: any): Promise<any>;
    /** 查看详情时统计实际切块数（chunkCount 是上传时冗余的，可能因重建索引而失真） */
    count?(args: any): Promise<number>;
  };
}

/** 取小写扩展名（规则与 mime.ts / 前端 getFileExt 一致） */
export function getExt(fileName: string): string {
  const name = String(fileName ?? '').trim();
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 把上传的文件转成可入库的纯文本
 *
 * 为什么是 async：docx / pdf 要用解析库抽文本，只能异步；
 * 文本类虽然同步就能解，但为了调用方只有一条路径，统一返回 Promise。
 *
 * @returns ok=true 时 text 是清洗后的正文；否则 error 是给用户看的说明
 */
export async function extractText(
  fileName: string,
  buffer: Buffer
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const ext = getExt(fileName);
  if (!ext) return { ok: false, error: '文件没有扩展名，无法识别格式' };

  let raw = '';
  if (TEXT_EXTS.has(ext)) {
    // 用 fatal 模式解码：非法 UTF-8 直接报错，而不是悄悄替换成乱码进知识库
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return { ok: false, error: '文件不是 UTF-8 编码，请另存为 UTF-8 后再上传' };
    }
    // 去掉 BOM 再统一清洗
    raw = raw.replace(/^\uFEFF/, '');
  } else if (ext === 'docx') {
    try {
      raw = await extractDocxText(buffer);
    } catch (error) {
      console.error('[knowledge] 解析 docx 失败', error);
      return { ok: false, error: '无法解析该 Word 文件，请确认它是有效的 .docx 文档' };
    }
  } else if (ext === 'pdf') {
    try {
      raw = await extractPdfText(buffer);
    } catch (error) {
      console.error('[knowledge] 解析 pdf 失败', error);
      return {
        ok: false,
        error: '无法解析该 PDF（可能已加密或是纯扫描图片），请先转成文字版或另存为 txt'
      };
    }
  } else if (ext === 'doc') {
    return { ok: false, error: DOC_HINT };
  } else {
    return { ok: false, error: `暂不支持 .${ext} 格式。目前支持：${SUPPORTED_EXTS.join('、')}` };
  }

  const text = normalizeText(raw);

  if (!text) return { ok: false, error: '文件内容为空' };
  // 扫描版 PDF 抽不出任何文字，字符数极少，单独给一句更明确的提示
  if ((ext === 'pdf' || ext === 'docx') && text.length < 10) {
    return {
      ok: false,
      error: '这个文件里几乎提取不到文字（可能是扫描件或纯图片），请上传文字版内容'
    };
  }
  if (text.length > MAX_DOC_CHARS) {
    return { ok: false, error: `文件内容过长（${text.length} 字），请拆分后再上传` };
  }
  return { ok: true, text };
}

/**
 * 用 mammoth 抽 docx 文本
 *
 * 为什么用 extractRawText 而不是 convertToHtml：
 *   知识库只需要纯文字给检索用，HTML 标签会变成噪音词（div、span 之类）污染 BM25。
 *   图片、样式、页眉页脚一律不要。
 *
 * 两个库都做成动态 import：只有真正上传 word/pdf 时才加载，
 * 不影响后端启动速度，测试环境也不会因为解析库初始化而变慢。
 */
async function extractDocxText(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return String(result?.value ?? '');
}

/**
 * 用 pdf-parse 抽 pdf 文本
 *
 * 两个坑：
 *   1. pageJoiner 默认会给每页末尾加 "\n-- 1 of 5 --" 这种标记，
 *      它是纯噪音，会被切进词条里污染检索，所以显式传空串关掉；
 *   2. destroy()：PDFParse 内部持有 worker 资源，不释放会泄漏，
 *      放 finally 里保证解析失败也回收。
 */
async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText({ pageJoiner: '' });
    return String(result?.text ?? '');
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** 把长文本切成「待入库」的切块（同时算好分词与词条数） */
export function makeChunkRows(
  text: string
): { seq: number; content: string; tokens: string; tokenCount: number }[] {
  return splitIntoChunks(text).map((content, seq) => {
    const tokens = tokenize(content);
    return { seq, content, tokens: tokensToString(tokens), tokenCount: tokens.length };
  });
}

/**
 * 解析 multipart/form-data（普通字段 + 单个文件）
 *
 * 与 upload.ts 的 parseMultipart 独立实现，因为这里额外需要文件名：
 * 前端在 Content-Disposition 里带上 filename，解析出来才能按扩展名判断格式，
 * 并把原始文件名展示给用户。
 */
export function parseMultipartWithFile(
  body: Buffer,
  contentType: string
): { fields: Record<string, string>; file: { name: string; data: Buffer } | null } {
  const fields: Record<string, string> = {};
  let file: { name: string; data: Buffer } | null = null;

  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2] || '').trim() : '';
  if (!Buffer.isBuffer(body) || !boundary) return { fields, file };

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
      const fileMatch = /filename="([^"]*)"/i.exec(headerText);
      if (fileMatch) {
        // 只取第一个文件（本项目没有多文件场景）
        if (!file) {
          file = { name: decodeFileName(fileMatch[1] || ''), data: Buffer.from(content) };
        }
      } else if (name) {
        fields[name] = content.toString('utf-8');
      }
    }

    position = nextBoundary;
  }

  return { fields, file };
}

/**
 * 还原 multipart 头里的文件名
 *
 * 浏览器一般直接发 UTF-8 原文，但个别客户端会做 percent-encoding，
 * 两种都得兼容，否则中文文件名会变成 %E4%B8%AD... 这样。
 */
export function decodeFileName(raw: string): string {
  const value = String(raw ?? '');
  if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}


/** 查询当前登录人是否为管理员（prisma 未注入时按非管理员处理，与 upload.ts 口径一致） */
async function isAdminUser(
  prisma: KnowledgeRoutesPrisma | undefined,
  userId: number
): Promise<boolean> {
  if (!prisma) return false;
  const currentUser = await prisma.user.findFirst({
    where: { id: userId },
    select: { role: true }
  });
  return currentUser?.role === 'admin';
}

export function registerKnowledgeRoutes(app: express.Express, prisma?: KnowledgeRoutesPrisma) {
  /**
   * 文档列表
   *
   * 管理员看全部，普通成员只看自己的 —— 与文件上传页的管理视图同一套规则。
   */
  app.get('/api/knowledge/docs', authMiddleware, async (req: AuthRequest, res) => {
    const userId = req.userId;
    if (!userId || !prisma) return res.status(401).json({ error: '未登录' });

    try {
      const isAdmin = await isAdminUser(prisma, userId);
      const rows = await prisma.knowledgeDoc.findMany({
        where: isAdmin ? {} : { ownerId: userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          ownerId: true,
          fileName: true,
          fileSize: true,
          charCount: true,
          chunkCount: true,
          createdAt: true,
          owner: { select: { username: true, account: true } }
        }
      });

      // 再走一遍纯函数过滤：即使查询条件写错，也不会把别人的文档漏出去
      const docs = rows
        .filter((row) => canListFileWithoutTask(row, userId, isAdmin))
        .map((row) => ({
          id: row.id,
          ownerId: row.ownerId,
          fileName: row.fileName,
          fileSize: row.fileSize,
          charCount: row.charCount,
          chunkCount: row.chunkCount,
          createdAt: row.createdAt,
          ownerName: row.owner?.username || row.owner?.account || '',
          // 前端据此决定「删除」按钮是否可点
          canDelete: canDeleteFile(row, userId, isAdmin)
        }));

      return res.json(docs);
    } catch (error) {
      console.error('[knowledge] 列出文档失败', error);
      return res.status(500).json({ error: '获取知识库列表失败' });
    }
  });


  /**
   * 查看文档详情（列表里的「查看」按钮）
   *
   * 返回上传时解析出的正文全文，因此纯文本类文件能直接在弹窗里阅读；
   * docx / pdf 已经抽成纯文字，原文件字节没有落盘（知识库只存文本），
   * 所以这两类只能看抽取后的文字，想看原版式需回本地打开源文件。
   *
   * 不做「下载原文件」：上传时只保留解析后的纯文本，docx / pdf 的原始字节
   * 没有落盘，凭空生成一个「原文件」反而会骗用户，因此这里明确只给正文文字。
   */
  app.get('/api/knowledge/docs/:id', authMiddleware, async (req: AuthRequest, res) => {
    const userId = req.userId;
    if (!userId || !prisma) return res.status(401).json({ error: '未登录' });

    const docId = Number(req.params.id);
    if (!Number.isInteger(docId) || docId <= 0) {
      return res.status(400).json({ error: '文档 id 不合法' });
    }

    try {
      const doc = await prisma.knowledgeDoc.findFirst({
        where: { id: docId },
        select: {
          id: true,
          ownerId: true,
          fileName: true,
          fileSize: true,
          content: true,
          charCount: true,
          chunkCount: true,
          createdAt: true,
          owner: { select: { username: true, account: true } }
        }
      });
      if (!doc) return res.status(404).json({ error: '文档不存在' });

      const isAdmin = await isAdminUser(prisma, userId);
      // 与列表同一套规则：列表里看不到的文档，直接改 URL 打开也只得到 404
      if (!canViewFileContent(doc, userId, isAdmin)) {
        return res.status(404).json({ error: '文档不存在' });
      }

      // 实际切块数优先用 count（chunkCount 是上传时的冗余值）；统计失败就退回冗余值
      let chunkCount = doc.chunkCount;
      if (typeof prisma.knowledgeChunk.count === 'function') {
        try {
          chunkCount = await prisma.knowledgeChunk.count({ where: { docId: doc.id } });
        } catch (error) {
          console.error('[knowledge] 统计切块失败，使用冗余值', error);
        }
      }

      const fullText = String(doc.content ?? '');
      // 超长正文截断返回，避免几百万字的文本把响应体和浏览器一起拖死
      const truncated = fullText.length > VIEW_CONTENT_LIMIT;
      const content = truncated ? fullText.slice(0, VIEW_CONTENT_LIMIT) : fullText;

      return res.json({
        id: doc.id,
        ownerId: doc.ownerId,
        fileName: doc.fileName,
        fileSize: doc.fileSize,
        charCount: doc.charCount,
        chunkCount,
        createdAt: doc.createdAt,
        ownerName: doc.owner?.username || doc.owner?.account || '',
        canDelete: canDeleteFile(doc, userId, isAdmin),
        content,
        truncated
      });
    } catch (error) {
      console.error('[knowledge] 查看文档失败', error);
      return res.status(500).json({ error: '获取文档内容失败' });
    }
  });


  /**
   * 上传文档并建立索引
   *
   * express.raw 直接读原始 body（上限 MAX_DOC_SIZE）；type: () => true
   * 表示不按 Content-Type 过滤，是不是 multipart 由下面自行判断。
   */
  app.post(
    '/api/knowledge/docs',
    authMiddleware,
    express.raw({ type: () => true, limit: MAX_DOC_SIZE }),
    async (req: AuthRequest, res) => {
      const userId = req.userId;
      if (!userId || !prisma) return res.status(401).json({ error: '未登录' });

      const contentType = String(req.headers['content-type'] || '');
      if (!/multipart\/form-data/i.test(contentType)) {
        return res.status(400).json({ error: '请用 multipart/form-data 上传文件' });
      }

      const { file } = parseMultipartWithFile(req.body as Buffer, contentType);
      if (!file || !file.data.length) {
        return res.status(400).json({ error: '没有收到文件' });
      }

      const extracted = await extractText(file.name, file.data);
      if (!extracted.ok) return res.status(400).json({ error: extracted.error });

      const chunkRows = makeChunkRows(extracted.text);
      if (!chunkRows.length) {
        return res.status(400).json({ error: '文件内容无法切分出有效片段' });
      }

      // 先建文档拿 id，再批量写切块；任一步失败都不留半成品
      let docId = 0;
      try {
        const doc = await prisma.knowledgeDoc.create({
          data: {
            ownerId: userId,
            fileName: file.name,
            fileSize: file.data.length,
            content: extracted.text,
            charCount: extracted.text.length,
            chunkCount: chunkRows.length
          }
        });
        docId = doc.id;

        await prisma.knowledgeChunk.createMany({
          data: chunkRows.map((row) => ({ ...row, docId }))
        });

        return res.status(201).json({
          id: doc.id,
          fileName: doc.fileName,
          fileSize: doc.fileSize,
          charCount: doc.charCount,
          chunkCount: doc.chunkCount,
          createdAt: doc.createdAt
        });
      } catch (error) {
        console.error('[knowledge] 保存文档失败', error);
        // 切块写入失败时把文档删掉，避免出现「文档在但永远搜不到」的孤儿
        if (docId) {
          try {
            await prisma.knowledgeDoc.delete({ where: { id: docId } });
          } catch {
            /* 清理失败不影响返回 */
          }
        }
        return res.status(500).json({ error: '保存知识库文档失败' });
      }
    }
  );


  /** 删除文档（切块由数据库外键级联删除） */
  app.delete('/api/knowledge/docs/:id', authMiddleware, async (req: AuthRequest, res) => {
    const userId = req.userId;
    if (!userId || !prisma) return res.status(401).json({ error: '未登录' });

    const docId = Number(req.params.id);
    if (!Number.isInteger(docId) || docId <= 0) {
      return res.status(400).json({ error: '文档 id 不合法' });
    }

    try {
      const doc = await prisma.knowledgeDoc.findFirst({
        where: { id: docId },
        select: { id: true, ownerId: true, fileName: true }
      });
      if (!doc) return res.status(404).json({ error: '文档不存在' });

      const isAdmin = await isAdminUser(prisma, userId);
      // 无权限时也返回 404：不暴露「这个 id 存在，只是不是你的」
      if (!canDeleteFile(doc, userId, isAdmin)) {
        return res.status(404).json({ error: '文档不存在' });
      }

      await prisma.knowledgeDoc.delete({ where: { id: docId } });
      return res.json({ success: true, id: docId });
    } catch (error) {
      console.error('[knowledge] 删除文档失败', error);
      return res.status(500).json({ error: '删除文档失败' });
    }
  });

  /**
   * 检索调试接口：只返回召回片段，不调用模型
   *
   * 为什么保留它：调 RAG 最常出问题的是「召回不准」而不是「模型不会答」，
   * 有这个接口能直接看到命中了哪些片段、分数多少，不必每次都烧一次模型调用。
   */
  app.post('/api/knowledge/search', authMiddleware, async (req: AuthRequest, res) => {
    const userId = req.userId;
    if (!userId || !prisma) return res.status(401).json({ error: '未登录' });

    const query = String(req.body?.query ?? '').trim();
    if (!query) return res.status(400).json({ error: '检索词不能为空' });

    try {
      const hits = await searchDocs(prisma, userId, query);
      return res.json(hits);
    } catch (error) {
      console.error('[knowledge] 检索失败', error);
      return res.status(500).json({ error: '检索失败' });
    }
  });
}


/**
 * 检索知识库（供 ai.ts 的 /chat 复用）
 *
 * 可见范围：本人上传的文档（管理员额外包含全部）——
 * 复用 canListFileWithoutTask，与列表接口同一套规则，
 * 避免出现「列表里看不到、却被 AI 引用」的信息越权。
 *
 * 只在候选集内做 BM25：知识库是「个人文档」量级（几十份），
 * 全量读进内存打分的成本远低于引入向量库或数据库全文索引。
 */
export async function searchDocs(
  prisma: KnowledgeRoutesPrisma,
  userId: number,
  query: string,
  limit?: number
): Promise<
  { docId: number; fileName: string; seq: number; score: number; snippet: string; content: string }[]
> {
  const isAdmin = await isAdminUser(prisma, userId);

  const docs = await prisma.knowledgeDoc.findMany({
    where: isAdmin ? {} : { ownerId: userId },
    select: { id: true, ownerId: true, fileName: true }
  });
  const visible = docs.filter((doc) => canListFileWithoutTask(doc, userId, isAdmin));
  if (!visible.length) return [];

  const fileNameMap = new Map<number, string>();
  for (const doc of visible) fileNameMap.set(doc.id, doc.fileName);

  const rows = await prisma.knowledgeChunk.findMany({
    where: { docId: { in: visible.map((doc) => doc.id) } },
    select: { docId: true, seq: true, content: true, tokens: true, tokenCount: true }
  });

  // 数据库里 tokens 是空格分隔的字符串，打分前还原成数组
  const chunks: ChunkRecord[] = rows.map((row) => ({
    docId: row.docId,
    seq: row.seq,
    content: row.content,
    tokens: String(row.tokens || '').split(' ').filter(Boolean),
    tokenCount: row.tokenCount
  }));

  const hits = scoreChunks(chunks, query, limit);
  const { sources } = buildContextBlock(hits, (docId) => fileNameMap.get(docId) || '');

  // 带上完整片段：ai.ts 拼上下文要用原文，而不是 120 字的摘要
  return sources.map((source, index) => ({
    ...source,
    content: hits[index]?.content ?? ''
  }));
}
