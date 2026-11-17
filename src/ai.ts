// ============================================================
// AI 答疑模块（对话窗口 + 会话历史）
//
// 提供接口：
//   GET    /api/ai/conversations            会话列表（本人）
//   POST   /api/ai/conversations            新建会话
//   PATCH  /api/ai/conversations/:id        重命名会话
//   DELETE /api/ai/conversations/:id        删除会话（级联删消息）
//   GET    /api/ai/conversations/:id/messages  会话消息（用于刷新后恢复历史）
//   POST   /api/ai/chat                     提问（SSE 流式返回）
//
// 工作流程（一句话概括）：
//   用户问题 → 取本会话最近若干条历史 → 拼成 messages → 调大模型（OpenAI 兼容
//   接口，流式）→ 一边转发给前端一边落库
//
// 设计要点：
//   1. 不内置任何本地知识库 / 离线兜底答案：回答内容 100% 来自调用方配置的模型
//      （DEEPSEEK_API_KEY + DEEPSEEK_BASE_URL + DEEPSEEK_MODEL，可换成任意
//      OpenAI 兼容服务）。没配置 key 时直接返回错误提示，避免用假数据糊弄用户；
//   2. 所有接口都要求登录，且严格按 userId 隔离（别人的会话一律 404，
//      不区分「不存在」和「无权限」，避免探测）；
//   3. 流式响应使用 text/event-stream，事件格式见下方 sendEvent；
//   4. 大模型报错时仍会把「用户消息」落库，assistant 消息写入错误说明，
//      保证历史记录里不会出现「问了但没有任何回答」的空洞。
// ============================================================

import express from 'express';
import { readFileSync } from 'node:fs';
import { authMiddleware, type AuthRequest } from './auth.ts';
import { searchDocs, type KnowledgeRoutesPrisma } from './knowledgeRoutes.ts';
import { buildContextBlock, buildRagSystemPrompt, type SearchHit } from './knowledge.ts';

// ---------- 可调参数（都支持环境变量覆盖，方便本地调试） ----------
// 大模型接口地址（OpenAI 兼容端点，默认示例为 DeepSeek）
const AI_BASE_URL = process.env.DEEPSEEK_BASE_URL;
// 默认模型：deepseek-chat；换成别家服务时用 DEEPSEEK_MODEL 覆盖
const AI_MODEL = process.env.DEEPSEEK_MODEL;
// 单次请求超时（毫秒）：流式场景下取首包时间，给足 60s
const AI_TIMEOUT = Number(process.env.AI_TIMEOUT_MS || 60_000);
// 带进上下文的历史消息条数（太多会挤占知识库内容，也太费 token）
const HISTORY_LIMIT = Number(process.env.AI_HISTORY_LIMIT || 8);
// 单条提问的最大长度，防止超长文本把模型费用打上去
const MAX_QUESTION_LENGTH = 2000;
// 会话标题长度（取首个问题的前 N 个字）
const TITLE_MAX_LENGTH = 20;

/** 消息角色：只允许这两种，避免前端伪造 system 消息 */
type ChatRole = 'user' | 'assistant';

/** 落库用的最小 Prisma 能力（只依赖实际用到的 delegate，方便测试时打桩） */
export interface AiRoutesPrisma {
  aiConversation: {
    findMany(args: any): Promise<any[]>;
    findFirst(args: any): Promise<any | null>;
    create(args: any): Promise<any>;
    update(args: any): Promise<any>;
    delete(args: any): Promise<any>;
  };
  aiMessage: {
    findMany(args: any): Promise<any[]>;
    create(args: any): Promise<any>;
  };
  /**
   * 知识库相关表（RAG 用）。
   *
   * 设计成可选：测试打桩通常只关心会话读写，没有这两张表也要能跑；
   * 缺省时 /chat 自动退化为「纯模型问答」，不会因为知识库不可用而整体报错。
   */
  user?: KnowledgeRoutesPrisma['user'];
  knowledgeDoc?: KnowledgeRoutesPrisma['knowledgeDoc'];
  knowledgeChunk?: KnowledgeRoutesPrisma['knowledgeChunk'];
}


/** 发给大模型的消息体（OpenAI 兼容格式） */
interface ModelMessage {
  role: 'system' | ChatRole;
  content: string;
}

// ---------- 纯函数工具（便于单测） ----------

/** 去掉首尾空白，并把连续 3 个以上换行压成 2 个（避免用户粘贴大段空白） */
export function normalizeQuestion(input: unknown): string {
  return String(input ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 校验提问内容
 * @returns ok=true 时 value 是清洗后的问题；否则 error 是给前端的提示
 */
export function validateQuestion(input: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const value = normalizeQuestion(input);
  if (!value) return { ok: false, error: '问题不能为空' };
  if (value.length > MAX_QUESTION_LENGTH) {
    return { ok: false, error: `问题太长了，请控制在 ${MAX_QUESTION_LENGTH} 字以内` };
  }
  return { ok: true, value };
}

/** 用首个问题生成会话标题（超长截断加省略号） */
export function makeTitle(question: string): string {
  const single = normalizeQuestion(question).replace(/\n+/g, ' ');
  if (single.length <= TITLE_MAX_LENGTH) return single || '新对话';
  return `${single.slice(0, TITLE_MAX_LENGTH)}…`;
}

/**
 * 拼出 system prompt：限定角色与回答风格
 *
 * 这里刻意不放任何项目内置资料 —— 业务知识完全交给所接入的模型，
 * 需要额外上下文时通过环境变量 AI_SYSTEM_PROMPT 覆盖整段提示词即可。
 */
export function buildSystemPrompt(): string {
  // 允许自定义整段提示词（比如接其它模型、要求特定的语气/格式）
  const custom = (process.env.AI_SYSTEM_PROMPT || '').trim();
  if (custom) return custom;
  // return [
  //   '你是「Geek Task Hub」项目内的 AI 答疑助手，负责解答与本项目使用相关的问题。',
  //   '回答要求：',
  //   '1. 使用简体中文，条理清晰，必要时用 Markdown 列表或代码块；',
  //   '2. 只依据你自身的知识和用户提供的信息作答，不确定时明确说明，不要编造功能或字段；',
  //   '3. 与项目完全无关的问题（闲聊、其他产品），礼貌说明你只负责本项目答疑。'
  // ].join('\n');
   return [
    '你是AI 答疑助手,可以回答一些常规问题,不涉及安全隐私',
    '回答要求：',
    '1. 使用简体中文，条理清晰，必要时用 Markdown 列表或代码块；',
    '2. 只依据你自身的知识和用户提供的信息作答，不确定时明确说明，不要编造功能或字段；'
  ].join('\n');
}

/**
 * 组装发给模型的消息列表
 * @param systemPrompt 系统提示词
 * @param history      历史消息（按时间正序，已裁剪）
 * @param question     本轮问题
 */

export function buildModelMessages(
  systemPrompt: string,
  history: { role: string; content: string }[],
  question: string
): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const item of history) {
    //数据过滤,包括历史对话和最新问题的数据，需要传到大模型的，这个方法过滤到数据中不符合要求或者为空的数据
    // 历史里可能混入别的角色，一律过滤，只保留 user / assistant
    if (item.role !== 'user' && item.role !== 'assistant') continue;
    if (!item.content) continue;
    messages.push({ role: item.role, content: item.content });
  }
  messages.push({ role: 'user', content: question });
  return messages;
}

/**
 * 检索知识库并拼出「带资料的 system prompt」
 *
 * 独立成函数是为了在 /chat 里能一眼看出 RAG 只做两件事：
 *   查资料 → 改 system prompt。其余（历史、落库、流式）完全不受影响。
 *
 * 容错策略：知识库表缺失、查询报错、没有命中，都只是「没有资料」，
 * 绝不能因此让整个问答失败 —— 退化成纯模型问答仍然可用。
 *
 * @returns sources 为空数组表示本次没有引用任何资料
 */
export async function retrieveKnowledge(
  prisma: AiRoutesPrisma,
  userId: number,
  question: string,
  basePrompt: string
): Promise<{ systemPrompt: string; sources: ReturnType<typeof buildContextBlock>['sources'] }> {
  const empty = { systemPrompt: basePrompt, sources: [] as ReturnType<typeof buildContextBlock>['sources'] };

  // 三张表都注入了才尝试检索（测试桩通常不提供）
  if (!prisma.user || !prisma.knowledgeDoc || !prisma.knowledgeChunk) return empty;

  try {
    const hits = await searchDocs(
      {
        user: prisma.user,
        knowledgeDoc: prisma.knowledgeDoc,
        knowledgeChunk: prisma.knowledgeChunk
      },
      userId,
      question
    );
    if (!hits.length) return empty;

    // searchDocs 已经带了 fileName，这里按 SearchHit 的形状喂给 buildContextBlock
    const asHits: SearchHit[] = hits.map((hit) => ({
      docId: hit.docId,
      seq: hit.seq,
      content: hit.content,
      score: hit.score
    }));
    const fileNameMap = new Map(hits.map((hit) => [hit.docId, hit.fileName]));
    const { text, sources } = buildContextBlock(asHits, (docId) => fileNameMap.get(docId) || '');

    return { systemPrompt: buildRagSystemPrompt(basePrompt, text), sources };
  } catch (error) {
    // 知识库坏了不该拖垮问答，记日志后按「无资料」继续
    console.error('[ai] 知识库检索失败，本次按纯模型问答处理', error);
    return empty;
  }
}

/**
 * 从模型返回的一行 SSE 数据里取出增量文本
 *
 * OpenAI 兼容接口返回的是标准流：
 *   data: {"choices":[{"delta":{"content":"你"}}]}
 *   data: [DONE]
 *
 * @returns 增量文本；不是有效数据（心跳、[DONE]、解析失败）时返回空字符串
 */
export function parseStreamChunk(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return '';
  const payload = trimmed.slice('data:'.length).trim();
  if (!payload || payload === '[DONE]') return '';
  try {
    const json = JSON.parse(payload) as {
      choices?: { delta?: { content?: unknown } }[];
    };
    const delta = json?.choices?.[0]?.delta;
    // enable_thinking=false 时不会返回 reasoning_content；
    // 万一模型吐了思考内容，也不要混进最终答案里
    return typeof delta?.content === 'string' ? delta.content : '';
  } catch {
    return '';
  }
}

// ---------- SSE（流式响应）工具 ----------

/**
 * 往 SSE 连接里写一个事件
 *
 * 前端用 fetch + ReadableStream 读取，按「空行」切分事件，
 * 所以每条消息都以 \n\n 结尾（这是 SSE 协议的硬性要求）。
 */
function sendEvent(res: express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 初始化 SSE 响应头 */
function openSse(res: express.Response) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 关掉 Nginx 等反向代理的缓冲，否则流式会「憋」成一整块
  res.setHeader('X-Accel-Buffering', 'no');
  // 立即把响应头发出去，避免客户端一直等着
  res.flushHeaders?.();
}

// ---------- 大模型调用 ----------

/** 密钥统一前缀（DeepSeek OpenAI 兼容格式），用于日志脱敏时定位 */
const SECRET_PATTERN = /sk-[A-Za-z0-9_-]{16,}/g;

/**
 * 模型接口状态码 → 稳定错误码。
 *
 * 为什么不让状态码直接透传：
 *   「模型接口返回 402：{"error":...}」这种文案对用户没有意义，
 *   而且不同模型服务商的状态码含义有差异，前端也不该去解析 HTTP 码。
 *   这里统一翻译成几个固定错误码，由 buildErrorAnswer 负责出人话。
 */
const MODEL_ERROR_BY_STATUS: Record<number, string> = {
  400: 'MODEL_BAD_REQUEST',
  401: 'MODEL_BAD_KEY',
  402: 'MODEL_NO_BALANCE',
  403: 'MODEL_FORBIDDEN',
  422: 'MODEL_BAD_REQUEST',
  429: 'MODEL_RATE_LIMIT',
  500: 'MODEL_SERVER_ERROR',
  503: 'MODEL_SERVER_ERROR'
};


/**
 * 把文本里可能出现的密钥片段抹掉，避免写进日志 / 报错信息。
 *
 * 用于任何要记录外部错误对象的场景：某些 HTTP 客户端会把请求头
 * （含 Authorization: Bearer sk-xxx）挂在 error 对象上，直接打日志就等于泄漏。
 */
export function redactSecret(text: string): string {
  return String(text ?? '').replace(SECRET_PATTERN, 'sk-***');
}

/**
 * 取模型 key。两种来源，按优先级：
 *
 *   1. DEEPSEEK_API_KEY_FILE —— 文件路径（Docker secret / K8s 挂载的常用形态）
 *   2. DEEPSEEK_API_KEY      —— 普通环境变量（本地 .env 最常见）
 *
 * 这样本地开发和容器部署能用同一份代码：本地读 .env，生产挂文件即可，
 * 不必为了「密钥怎么注入」去改业务逻辑。
 */
export function resolveApiKey(): string {
  const keyFile = (process.env.DEEPSEEK_API_KEY_FILE || '').trim();
  if (keyFile) {
    try {
      const content = readFileSync(keyFile, 'utf8').trim();
      if (content) return content;
    } catch {
      // 文件不存在 / 无权限时回退到普通环境变量，避免服务直接起不来。
      // 注意：这里不要把 keyFile 的路径拼进报错，避免暴露内部目录结构。
    }
  }
  return (process.env.DEEPSEEK_API_KEY || '').trim();
}


/**
 * 调用大模型（OpenAI 兼容）流式接口，边收边通过 onDelta 回调
 *
 * @returns 完整回答文本
 * @throws  未配置 key（错误信息为 NO_API_KEY）、HTTP 非 2xx、或流式过程中断
 */
async function callModel(
  messages: ModelMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }

  // 超时控制：用 AbortController 在 60s 后主动掐断，避免请求永远挂着
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT);
  // 前端断开（关页面 / 停止生成）时也把请求掐掉，省得白烧 token
  signal?.addEventListener('abort', () => controller.abort());

  try {
    const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        stream: true,
        // qwen3 系列默认会先「思考」再回答，这里关掉，只取最终答案
        enable_thinking: false,
        temperature: 0.3
      }),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      // 把常见状态码翻译成稳定的错误码，供上层生成友好文案。
      // 覆盖依据 DeepSeek 官方错误码表：
      //   402 余额不足 / 401 key 无效 / 429 触发限流 / 5xx 服务端故障
      const mapped = MODEL_ERROR_BY_STATUS[response.status];
      const suffix = detail ? `：${detail.slice(0, 200)}` : '';
      throw new Error(`${mapped ?? `模型接口返回 ${response.status}`}${suffix}`);
    }

    // 用 getReader 手工读流：Node 的 fetch 返回的是 Web ReadableStream
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let answer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件之间用空行分隔；不同实现可能用 \n\n 或 \r\n\r\n
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        // 一个事件里可能有多行 data:，逐行解析并拼接
        for (const line of rawEvent.split(/\r?\n/)) {
          const delta = parseStreamChunk(line);
          if (!delta) continue;
          answer += delta;
          onDelta(delta);
        }
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }

    // 流结束时可能还有没被空行终结的最后一段
    for (const line of buffer.split(/\r?\n/)) {
      const delta = parseStreamChunk(line);
      if (!delta) continue;
      answer += delta;
      onDelta(delta);
    }

    return answer;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 路由注册 ----------

/**
 * 注册 AI 答疑相关路由（在 app.listen 之前调用）
 * @param app    Express 应用
 * @param prisma Prisma 客户端（由 index.ts 传入，保持单实例）
 */
export function registerAiRoutes(app: express.Express, prisma: AiRoutesPrisma) {
  // 会话列表：按「最近活跃」倒序，只返回本人的会话
  // 同时带上 messageCount，方便前端在列表里展示条数（没有消息的会话是 0）
  app.get('/api/ai/conversations', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: '未登录' });

      const list = await prisma.aiConversation.findMany({
        where: { userId },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { messages: true } }
        }
      });

      res.json(
        list.map((item) => ({
          id: item.id,
          title: item.title,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          messageCount: item._count?.messages ?? 0
        }))
      );
    } catch (error) {
      res.status(500).json({ error: '获取会话列表失败' });
    }
  });

  // 新建会话：可以不传标题（默认「新对话」），也可以传首个问题当标题
  app.post('/api/ai/conversations', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: '未登录' });

      const rawTitle = normalizeQuestion(req.body?.title);
      const conversation = await prisma.aiConversation.create({
        data: {
          userId,
          title: rawTitle ? makeTitle(rawTitle) : '新对话'
        }
      });
      res.status(201).json(conversation);
    } catch (error) {
      res.status(500).json({ error: '新建会话失败' });
    }
  });

  // 重命名会话
  app.patch('/api/ai/conversations/:id', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: '未登录' });

      const title = normalizeQuestion(req.body?.title);
      if (!title) return res.status(400).json({ error: '标题不能为空' });

      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: '会话 ID 不合法' });
      }

      // 归属校验：只能改自己的会话（别人的当作不存在，避免探测）
      const existing = await prisma.aiConversation.findFirst({ where: { id, userId } });
      if (!existing) return res.status(404).json({ error: '会话不存在' });

      const updated = await prisma.aiConversation.update({
        where: { id },
        data: { title: makeTitle(title) }
      });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ error: '重命名失败' });
    }
  });

  // 删除会话：数据库外键 onDelete: Cascade，消息会一起删掉
  app.delete('/api/ai/conversations/:id', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: '未登录' });

      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: '会话 ID 不合法' });
      }

      const existing = await prisma.aiConversation.findFirst({ where: { id, userId } });
      if (!existing) return res.status(404).json({ error: '会话不存在' });

      await prisma.aiConversation.delete({ where: { id } });
      res.json({ message: '删除成功' });
    } catch (error) {
      res.status(500).json({ error: '删除会话失败' });
    }
  });

  // 会话消息：按 id 正序（即时间正序），用于刷新页面后恢复历史
  app.get('/api/ai/conversations/:id/messages', authMiddleware, async (req: AuthRequest, res) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: '未登录' });

      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: '会话 ID 不合法' });
      }

      const existing = await prisma.aiConversation.findFirst({ where: { id, userId } });
      if (!existing) return res.status(404).json({ error: '会话不存在' });

      const messages = await prisma.aiMessage.findMany({
        where: { conversationId: id },
        orderBy: { id: 'asc' },
        select: { id: true, role: true, content: true, createdAt: true }
      });
      res.json(messages);
    } catch (error) {
      res.status(500).json({ error: '获取消息失败' });
    }
  });

  // ---------- 提问（SSE 流式） ----------
  // 请求体：{ conversationId?: number, question: string }
  // 不传 conversationId 时自动新建一个会话（标题取问题前 20 字）
  //
  // 事件：
  //   event: meta    { conversationId, title }              —— 首包，前端据此更新侧边栏
  //   event: delta   { content: '增量文本' }                 —— 多次
  //   event: done    { messageId, content }                  —— 结束
  //   event: error   { error: '提示' }                       —— 出错（此时不再发 done）
  app.post('/api/ai/chat', authMiddleware, async (req: AuthRequest, res) => {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: '未登录' });

    const checked = validateQuestion(req.body?.question);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const question = checked.value;

    // 会话解析放在开流之前：会话不存在等错误直接走普通 JSON，前端拿到的
    // 仍是统一格式的错误提示（不会出现「200 但是错误事件」的歧义）
    let conversationId = Number(req.body?.conversationId);
    let conversationTitle = '';
    try {
      if (Number.isInteger(conversationId) && conversationId > 0) {
        const existing = await prisma.aiConversation.findFirst({
          where: { id: conversationId, userId }
        });
        if (!existing) return res.status(404).json({ error: '会话不存在' });
        conversationTitle = existing.title;
      } else {
        const created = await prisma.aiConversation.create({
          data: { userId, title: makeTitle(question) }
        });
        conversationId = created.id;
        conversationTitle = created.title;
      }
    } catch (error) {
      return res.status(500).json({ error: '会话准备失败' });
    }

    // 先落库「用户消息」
    let userMessageId = 0;
    try {
      const saved = await prisma.aiMessage.create({
        data: { conversationId, role: 'user', content: question }
      });
      userMessageId = saved.id;
    } catch (error) {
      return res.status(500).json({ error: '保存消息失败' });
    }

    // 取最近的历史消息（不含刚写入的这条），用于多轮上下文
    let history: { role: string; content: string }[] = [];
    try {
      const rows = await prisma.aiMessage.findMany({
        where: { conversationId, id: { lt: userMessageId } },
        orderBy: { id: 'desc' },
        take: HISTORY_LIMIT,
        select: { role: true, content: true }
      });
      // findMany 取的是「最近 N 条倒序」，这里翻回时间正序再喂给模型
      history = rows.reverse();
    } catch (error) {
      // 历史取不到不影响主流程，退化成单轮问答
      history = [];
    }

    // ---------- 开始流式响应 ----------
    openSse(res);

    // 浏览器关页面 / 点「停止生成」时连接会关闭，这里记录一下用于提前收尾
    let clientClosed = false;
    const abortController = new AbortController();
    req.on('close', () => {
      clientClosed = true;
      abortController.abort();
    });

    sendEvent(res, 'meta', {
      conversationId,
      title: conversationTitle
    });

    let answer = '';
    // 是否已经推过 error 事件：出错时不再发 done，前端走 onError 分支
    let failed = false;
    try {
      // RAG：先查知识库，命中则把资料拼进 system prompt（未命中就沿用原提示词）
      const basePrompt = buildSystemPrompt();
      const { systemPrompt, sources } = await retrieveKnowledge(prisma, userId, question, basePrompt);

      // 引用来源要在正文之前推给前端，这样气泡一出现就能渲染「参考来源」
      if (sources.length && !clientClosed) {
        sendEvent(res, 'sources', { sources });
      }

      const messages = buildModelMessages(systemPrompt, history, question);
      answer = await callModel(
        messages,
        (delta) => {
          if (clientClosed) return;
          sendEvent(res, 'delta', { content: delta });
        },
        abortController.signal
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 没有本地兜底答案：模型不可用就如实告知，并把失败交给前端（onError 会提示用户）
      failed = true;

      // 面向用户：只给「能做什么」的友好文案，不含服务商/密钥/配置细节。
      answer = buildErrorAnswer(reason);

      // 面向开发者（本人排查）：完整技术原因打到后端日志，并做密钥脱敏，
      // 避免把 Authorization 头里的 sk-xxx 写进日志文件。
      // 这条日志不进前端、不进数据库，只在本机终端可见。
      console.error(`[ai] 模型调用失败 code=${describeErrorCode(reason)} reason=${redactSecret(reason)}`);

      if (!clientClosed) {
        // 先推一段说明让气泡里有内容，再推 error 触发前端错误态
        sendEvent(res, 'delta', { content: answer });
        sendEvent(res, 'error', { error: answer });
      }
    }

    // 模型返回空内容（极少数情况）：补一句提示，避免历史里出现空白的 AI 消息
    if (!answer.trim()) {
      answer = '抱歉，这次没有生成有效回答，请换一种问法再试。';
      if (!clientClosed) sendEvent(res, 'delta', { content: answer });
    }

    // 落库 assistant 消息，并刷新会话的活跃时间（列表据此排序）
    let assistantMessageId = 0;
    let savedToHistory = true;
    try {
      const saved = await prisma.aiMessage.create({
        data: { conversationId, role: 'assistant', content: answer }
      });
      assistantMessageId = saved.id;
      await prisma.aiConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() }
      });
    } catch (error) {
      // 落库失败不影响用户已经看到的答案，但要如实告知「历史没存上」
      savedToHistory = false;
      if (!clientClosed) sendEvent(res, 'error', { error: '回答已生成，但保存历史失败' });
    }

    if (!clientClosed) {
      // 出错时已经推过 error：按协议不再发 done（前端以 error 为准），直接收尾
      if (!failed) {
        sendEvent(res, 'done', {
          messageId: assistantMessageId,
          content: answer,
          saved: savedToHistory
        });
      }
      res.end();
    }
  });
}

/**
 * 从错误信息里取出稳定的错误码。
 *
 * callModel 抛出的形如 `MODEL_NO_BALANCE：{"error":...}`：
 * 错误码本身不含「：」，所以取第一段即可；没有「：」时返回原串。
 */
export function describeErrorCode(reason: string): string {
  // 用 split 后取首段；严格模式下索引访问可能是 undefined，故给一个兜底空串
  return String(reason ?? '').split('：')[0]?.trim() ?? '';
}

/**
 * 模型不可用时的说明文案（不再用本地知识库兜底）
 *
 * 原则：这段文字会通过 SSE 推给前端、并弹在用户界面上，
 * 所以只说「发生了什么 + 能做什么」，绝不出现服务商名称、变量名、
 * 密钥前缀、配置文件路径等实现细节——这些只写进后端日志。
 */
export function buildErrorAnswer(reason: string): string {
  const code = describeErrorCode(reason);
  if (code === 'NO_API_KEY') {
    // 用户侧只说「未配置」，不暴露变量名；
    // 具体该配哪些变量由 .env.example 和启动时日志负责，面向的是开发者。
    return [
      '**AI 服务尚未配置完成**，暂时无法回答。',
      '',
      '请联系管理员完成 AI 服务接入配置后重试。'
    ].join('\n');
  }

  if (code === 'MODEL_NO_BALANCE') {
    // 预付费模型服务余额为 0 时接口返回 402。
    // 这段文字会通过 ElMessage 直接弹给使用者，所以只说「余额不足、联系管理员」，
    // 不出现服务商名称、密钥、配置文件等技术细节；完整原因写在后端日志。
    return [
      '**AI 服务余额不足**，暂时无法回答。',
      '',
      '请联系管理员为模型账户充值后重试。',
      '充值完成后无需其它操作，重新提问即可恢复。'
    ].join('\n');
  }

  if (code === 'MODEL_BAD_KEY') {
    return [
      '**AI 服务配置异常**，暂时无法回答。',
      '',
      '请联系管理员检查 AI 服务配置后重试。'
    ].join('\n');
  }

  if (code === 'MODEL_RATE_LIMIT') {
    return '当前提问人数较多，已触发频率限制。请稍等几秒后重试。';
  }

  if (code === 'MODEL_SERVER_ERROR') {
    return 'AI 服务暂时繁忙，请稍后重试。';
  }

  if (code === 'MODEL_BAD_REQUEST') {
    // 这类通常是提问过长 / 含非法字符，提示用户自己调整即可，不必给技术细节
    return '这条提问没有被 AI 服务接受，请精简内容或换一种问法后重试。';
  }

  // 兜底：同样不把内部错误码抛给用户，只在日志里保留
  return '抱歉，AI 服务暂时不可用，请稍后重试。若持续出现，请联系管理员。';
}

