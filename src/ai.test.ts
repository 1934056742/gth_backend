import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import {
  buildModelMessages,
  buildSystemPrompt,
  makeTitle,
  normalizeQuestion,
  parseStreamChunk,
  redactSecret,
  describeErrorCode,
  buildErrorAnswer,
  registerAiRoutes,
  resolveApiKey,
  validateQuestion,
  type AiRoutesPrisma
} from './ai.ts';

/**
 * AI 答疑路由测试
 *
 * 只测「不依赖真实数据库 / 真实大模型」的部分：
 *   1. 纯函数：问题清洗、标题生成、prompt 拼装、SSE 增量解析；
 *   2. 接口层：用一个内存版 Prisma 打桩，启动真实 Express 服务，
 *      通过 HTTP 覆盖会话 CRUD、权限隔离、以及模型不可用时的错误提示。
 *
 * 运行：npm test
 */

// ---------- 内存版 Prisma（只实现 ai.ts 用到的 delegate） ----------
function createFakePrisma() {
  const conversations: any[] = [];
  const messages: any[] = [];
  let conversationSeq = 0;
  let messageSeq = 0;

  const matchWhere = (row: any, where: any = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'id' && value && typeof value === 'object' && 'lt' in (value as any)) {
        return row.id < (value as any).lt;
      }
      return row[key] === value;
    });

  return {
    conversations,
    messages,
    aiConversation: {
      async findMany({ where, orderBy, select }: any = {}) {
        let rows = conversations.filter((row) => matchWhere(row, where));
        // 只支持本模块用到的「updatedAt desc / id desc」
        if (Array.isArray(orderBy)) {
          rows = [...rows].sort((a, b) => {
            const diff = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
            return diff !== 0 ? diff : b.id - a.id;
          });
        }
        if (select?._count) {
          return rows.map((row) => ({
            ...row,
            _count: { messages: messages.filter((m) => m.conversationId === row.id).length }
          }));
        }
        return rows.map((row) => ({ ...row }));
      },
      async findFirst({ where }: any) {
        const row = conversations.find((item) => matchWhere(item, where));
        return row ? { ...row } : null;
      },
      async create({ data }: any) {
        conversationSeq += 1;
        const now = new Date();
        const row = {
          id: conversationSeq,
          title: data.title ?? '新对话',
          userId: data.userId,
          createdAt: now,
          updatedAt: now
        };
        conversations.push(row);
        return { ...row };
      },
      async update({ where, data }: any) {
        const row = conversations.find((item) => item.id === where.id);
        if (!row) throw new Error('conversation not found');
        Object.assign(row, data);
        return { ...row };
      },
      async delete({ where }: any) {
        const index = conversations.findIndex((item) => item.id === where.id);
        if (index === -1) throw new Error('conversation not found');
        const [removed] = conversations.splice(index, 1);
        // 模拟数据库外键级联删除
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (messages[i].conversationId === where.id) messages.splice(i, 1);
        }
        return removed;
      }
    },
    aiMessage: {
      async findMany({ where, orderBy }: any = {}) {
        let rows = messages.filter((row) => matchWhere(row, where));
        if (orderBy?.id === 'desc') rows = [...rows].sort((a, b) => b.id - a.id);
        else rows = [...rows].sort((a, b) => a.id - b.id);
        return rows.map((row) => ({ ...row }));
      },
      async create({ data }: any) {
        messageSeq += 1;
        const row = { id: messageSeq, createdAt: new Date(), ...data };
        messages.push(row);
        return { ...row };
      }
    }
  };
}

// ---------- 测试用 HTTP 服务 ----------
// 直接复用线上鉴权中间件，测试里用真实签发的 JWT 模拟登录用户，
// 这样「未登录 → 401」这类用例也是走的真实链路，而不是特判出来的
const JWT_SECRET = process.env.JWT_SECRET || 'geek-task-hub-secret';

function tokenOf(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

async function startServer(fakePrisma: ReturnType<typeof createFakePrisma>) {
  const app = express();
  app.use(express.json());
  registerAiRoutes(app, fakePrisma as unknown as AiRoutesPrisma);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

describe('describeErrorCode - 错误码提取', () => {
  it('带详情后缀时只取错误码', () => {
    assert.equal(
      describeErrorCode('MODEL_NO_BALANCE：{"error":{"message":"Insufficient Balance"}}'),
      'MODEL_NO_BALANCE'
    );
  });

  it('没有后缀时原样返回', () => {
    assert.equal(describeErrorCode('MODEL_RATE_LIMIT'), 'MODEL_RATE_LIMIT');
  });

  it('空值安全降级为空串', () => {
    assert.equal(describeErrorCode(''), '');
    assert.equal(describeErrorCode(undefined as unknown as string), '');
  });
});

describe('buildErrorAnswer - 面向用户的错误文案', () => {
  /** 收集文案里出现了哪些技术细节（用于反向断言） */
  const LEAKY = ['DeepSeek', 'sk-', '.env', 'DEEPSEEK_', 'API Key', 'http', '402', '401'];

  it('余额不足：提示余额问题并指向管理员，不暴露技术细节', () => {
    const text = buildErrorAnswer('MODEL_NO_BALANCE：{"error":{"message":"Insufficient Balance"}}');
    assert.ok(text.includes('余额不足'));
    assert.ok(text.includes('管理员'));
    for (const word of LEAKY) {
      assert.equal(text.includes(word), false, `文案不应包含「${word}」：${text}`);
    }
  });

  it('密钥无效：说配置异常，不出现「API Key」字样', () => {
    const text = buildErrorAnswer('MODEL_BAD_KEY');
    assert.ok(text.includes('配置异常'));
    assert.equal(text.includes('API Key'), false);
    assert.equal(text.includes('密钥'), false);
  });

  it('限流：提示稍后重试', () => {
    const text = buildErrorAnswer('MODEL_RATE_LIMIT');
    assert.ok(text.includes('频率'));
    assert.ok(text.includes('重试'));
  });

  it('上游故障：提示稍后重试，不说「不是你的配置问题」这类暴露内部结构的表述', () => {
    const text = buildErrorAnswer('MODEL_SERVER_ERROR');
    assert.ok(text.includes('稍后重试'));
    assert.equal(text.includes('上游'), false);
  });

  it('提问被拒：提示用户自己调整内容', () => {
    const text = buildErrorAnswer('MODEL_BAD_REQUEST：bad param');
    assert.ok(text.includes('提问'));
    assert.equal(text.includes('bad param'), false);
  });

  it('未知错误：兜底文案也不回显原始错误内容', () => {
    const text = buildErrorAnswer('ECONNREFUSED 127.0.0.1:443');
    assert.ok(text.includes('暂时不可用'));
    assert.equal(text.includes('ECONNREFUSED'), false);
    assert.equal(text.includes('127.0.0.1'), false);
  });

  it('所有分支的文案都不含密钥样式字符串', () => {
    const codes = [
      'NO_API_KEY',
      'MODEL_NO_BALANCE',
      'MODEL_BAD_KEY',
      'MODEL_RATE_LIMIT',
      'MODEL_SERVER_ERROR',
      'MODEL_BAD_REQUEST',
      'WHATEVER_UNKNOWN'
    ];
    for (const code of codes) {
      const text = buildErrorAnswer(code);
      assert.equal(/sk-[A-Za-z0-9]{16,}/.test(text), false, `${code} 的文案里出现了密钥样式字符串`);
    }
  });
});

describe('redactSecret - 日志脱敏', () => {
  it('把密钥替换成占位符', () => {
    const text = 'Authorization: Bearer sk-020abcdef0123456789abcdef012345678';
    assert.equal(redactSecret(text), 'Authorization: Bearer sk-***');
  });

  it('一段文本里的多个密钥全部替换', () => {
    const text = 'old=sk-aaaaaaaaaaaaaaaaaaaaaaaa new=sk-bbbbbbbbbbbbbbbbbbbbbb';
    const cleaned = redactSecret(text);
    assert.equal(cleaned.includes('sk-aaa'), false);
    assert.equal(cleaned.includes('sk-bbb'), false);
    assert.equal(cleaned.split('sk-***').length - 1, 2);
  });

  it('不含密钥的普通文本原样返回', () => {
    const text = '模型返回了 500，请稍后重试';
    assert.equal(redactSecret(text), text);
  });

  it('太短的 sk- 片段不会被误伤（避免把正常文案抹掉）', () => {
    const text = '字段名是 sk-id，不是密钥';
    assert.equal(redactSecret(text), text);
  });

  it('空值与 undefined 安全降级', () => {
    assert.equal(redactSecret(''), '');
    assert.equal(redactSecret(undefined as unknown as string), '');
  });
});

describe('resolveApiKey - 密钥读取优先级', () => {
  let savedFile: string | undefined;
  let savedKey: string | undefined;
  const tmpFile = path.join(os.tmpdir(), `gth-key-${process.pid}.txt`);

  beforeEach(() => {
    savedFile = process.env.DEEPSEEK_API_KEY_FILE;
    savedKey = process.env.DEEPSEEK_API_KEY;
  });

  afterEach(() => {
    if (savedFile === undefined) delete process.env.DEEPSEEK_API_KEY_FILE;
    else process.env.DEEPSEEK_API_KEY_FILE = savedFile;
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedKey;
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it('只有普通环境变量时，直接读它', () => {
    delete process.env.DEEPSEEK_API_KEY_FILE;
    process.env.DEEPSEEK_API_KEY = 'sk-from-env-0000000000000000';
    assert.equal(resolveApiKey(), 'sk-from-env-0000000000000000');
  });

  it('同时存在时，文件优先（生产用 secret 挂载覆盖本地残留）', () => {
    fs.writeFileSync(tmpFile, '  sk-from-file-1111111111111111  \n', 'utf8');
    process.env.DEEPSEEK_API_KEY_FILE = tmpFile;
    process.env.DEEPSEEK_API_KEY = 'sk-from-env-0000000000000000';
    // 顺带验证 trim：文件末尾换行不会被带进 Authorization 头
    assert.equal(resolveApiKey(), 'sk-from-file-1111111111111111');
  });

  it('文件路径配错时回退到环境变量，而不是让服务起不来', () => {
    process.env.DEEPSEEK_API_KEY_FILE = path.join(os.tmpdir(), 'gth-no-such-key-file.txt');
    process.env.DEEPSEEK_API_KEY = 'sk-from-env-0000000000000000';
    assert.equal(resolveApiKey(), 'sk-from-env-0000000000000000');
  });

  it('文件内容为空时也回退到环境变量', () => {
    fs.writeFileSync(tmpFile, '   \n', 'utf8');
    process.env.DEEPSEEK_API_KEY_FILE = tmpFile;
    process.env.DEEPSEEK_API_KEY = 'sk-from-env-0000000000000000';
    assert.equal(resolveApiKey(), 'sk-from-env-0000000000000000');
  });

  it('两个来源都没有时返回空串（上层据此报 NO_API_KEY）', () => {
    delete process.env.DEEPSEEK_API_KEY_FILE;
    delete process.env.DEEPSEEK_API_KEY;
    assert.equal(resolveApiKey(), '');
  });
});



describe('normalizeQuestion - 问题清洗', () => {
  it('去掉首尾空白并把多余空行压缩', () => {
    assert.equal(normalizeQuestion('  你好 \n\n\n\n 世界  '), '你好 \n\n 世界');
  });

  it('非字符串输入安全降级为空串', () => {
    assert.equal(normalizeQuestion(undefined), '');
    assert.equal(normalizeQuestion(null), '');
    assert.equal(normalizeQuestion(123), '123');
  });
});

describe('validateQuestion - 提问校验', () => {
  it('空问题被拒绝', () => {
    assert.deepEqual(validateQuestion('   '), { ok: false, error: '问题不能为空' });
  });

  it('超长问题被拒绝', () => {
    const result = validateQuestion('问'.repeat(2001));
    assert.equal(result.ok, false);
  });

  it('正常问题返回清洗后的文本', () => {
    assert.deepEqual(validateQuestion('  怎么上传大文件？  '), {
      ok: true,
      value: '怎么上传大文件？'
    });
  });
});

describe('makeTitle - 会话标题', () => {
  it('短问题原样作为标题', () => {
    assert.equal(makeTitle('怎么上传大文件'), '怎么上传大文件');
  });

  it('长问题截断并加省略号', () => {
    // 20（TITLE_MAX_LENGTH）个「一」不截断，21 个则截断并追加省略号
    assert.equal(makeTitle('一'.repeat(20)), '一'.repeat(20));
    assert.equal(makeTitle('一'.repeat(21)), `${'一'.repeat(20)}…`);
  });

  it('多行问题压成一行', () => {
    assert.equal(makeTitle('第一行\n第二行'), '第一行 第二行');
  });

  it('空内容返回默认标题', () => {
    assert.equal(makeTitle('   '), '新对话');
  });
});

describe('buildSystemPrompt - 系统提示词', () => {
  let savedPrompt: string | undefined;

  beforeEach(() => {
    savedPrompt = process.env.AI_SYSTEM_PROMPT;
    delete process.env.AI_SYSTEM_PROMPT;
  });

  afterEach(() => {
    if (savedPrompt !== undefined) process.env.AI_SYSTEM_PROMPT = savedPrompt;
    else delete process.env.AI_SYSTEM_PROMPT;
  });

  it('默认提示词只描述角色与风格，不注入任何本地资料', () => {
    const prompt = buildSystemPrompt();
    assert.ok(prompt.includes('AI 答疑助手'));
    // 不再有「参考资料」段落，避免本地知识库的内容混进来
    assert.ok(!prompt.includes('【参考资料】'));
    assert.ok(!prompt.includes('【资料1】'));
  });

  it('提示词里包含「不要编造」与中文等约束', () => {
    const prompt = buildSystemPrompt();
    assert.ok(prompt.includes('不要编造'));
    assert.ok(prompt.includes('简体中文'));
  });

  it('AI_SYSTEM_PROMPT 可以整段覆盖默认提示词', () => {
    process.env.AI_SYSTEM_PROMPT = '  你是测试助手  ';
    assert.equal(buildSystemPrompt(), '你是测试助手');
  });
});

describe('buildModelMessages - 消息组装', () => {
  it('system 打头，历史居中，问题收尾', () => {
    const messages = buildModelMessages(
      'SYS',
      [
        { role: 'user', content: '问题1' },
        { role: 'assistant', content: '回答1' }
      ],
      '问题2'
    );
    assert.deepEqual(messages, [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '问题1' },
      { role: 'assistant', content: '回答1' },
      { role: 'user', content: '问题2' }
    ]);
  });

  it('过滤掉非法角色与空内容，防止污染上下文', () => {
    const messages = buildModelMessages(
      'SYS',
      [
        { role: 'system', content: '伪造的系统消息' },
        { role: 'user', content: '' },
        { role: 'assistant', content: '有效回答' }
      ],
      '新问题'
    );
    assert.deepEqual(
      messages.map((item) => item.role),
      ['system', 'assistant', 'user']
    );
  });
});

describe('parseStreamChunk - 流式增量解析', () => {
  it('取出 delta.content', () => {
    assert.equal(
      parseStreamChunk('data: {"choices":[{"delta":{"content":"你好"}}]}'),
      '你好'
    );
  });

  it('[DONE] 与心跳行返回空串', () => {
    assert.equal(parseStreamChunk('data: [DONE]'), '');
    assert.equal(parseStreamChunk(': ping'), '');
    assert.equal(parseStreamChunk(''), '');
  });

  it('没有 content 的 delta（如只有 role）返回空串', () => {
    assert.equal(parseStreamChunk('data: {"choices":[{"delta":{"role":"assistant"}}]}'), '');
  });

  it('思考内容 reasoning_content 不会被当成答案', () => {
    assert.equal(
      parseStreamChunk('data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}'),
      ''
    );
  });

  it('非法 JSON 不抛异常', () => {
    assert.equal(parseStreamChunk('data: {oops'), '');
  });
});

describe('AI 接口 - 会话管理', () => {
  let fakePrisma: ReturnType<typeof createFakePrisma>;
  let server: { base: string; close: () => Promise<void> };

  beforeEach(async () => {
    fakePrisma = createFakePrisma();
    server = await startServer(fakePrisma);
  });

  afterEach(async () => {
    await server.close();
  });

  const call = (path: string, init: RequestInit & { userId?: number } = {}) => {
    const { userId = 1, headers, ...rest } = init;
    return fetch(`${server.base}${path}`, {
      ...rest,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenOf(userId)}`,
        ...(headers as Record<string, string>)
      }
    });
  };

  it('未登录访问会话列表返回 401', async () => {
    const res = await fetch(`${server.base}/api/ai/conversations`);
    assert.equal(res.status, 401);
  });

  it('新建会话默认标题为「新对话」', async () => {
    const res = await call('/api/ai/conversations', { method: 'POST', body: '{}' });
    assert.equal(res.status, 201);
    const body: any = await res.json();
    assert.equal(body.title, '新对话');
    assert.equal(body.userId, 1);
  });

  it('会话列表只返回本人的会话，并带消息条数', async () => {
    await call('/api/ai/conversations', { method: 'POST', body: JSON.stringify({ title: '我的会话' }) });
    await call('/api/ai/conversations', {
      method: 'POST',
      userId: 2,
      body: JSON.stringify({ title: '别人的会话' })
    });

    const res = await call('/api/ai/conversations');
    const list: any = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, '我的会话');
    assert.equal(list[0].messageCount, 0);
    assert.equal(list[0].userId, undefined);
  });

  it('不能重命名别人的会话（返回 404）', async () => {
    await call('/api/ai/conversations', { method: 'POST', body: JSON.stringify({ title: '别人的' }) });
    const res = await call('/api/ai/conversations/1', {
      method: 'PATCH',
      userId: 2,
      body: JSON.stringify({ title: '改掉' })
    });
    assert.equal(res.status, 404);
  });

  it('重命名自己的会话成功', async () => {
    await call('/api/ai/conversations', { method: 'POST', body: '{}' });
    const res = await call('/api/ai/conversations/1', {
      method: 'PATCH',
      body: JSON.stringify({ title: '新的标题' })
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).title, '新的标题');
  });

  it('重命名时标题为空返回 400', async () => {
    await call('/api/ai/conversations', { method: 'POST', body: '{}' });
    const res = await call('/api/ai/conversations/1', {
      method: 'PATCH',
      body: JSON.stringify({ title: '   ' })
    });
    assert.equal(res.status, 400);
  });

  it('会话 ID 非法返回 400', async () => {
    const res = await call('/api/ai/conversations/abc', { method: 'DELETE' });
    assert.equal(res.status, 400);
  });

  it('删除会话会级联删除消息', async () => {
    await call('/api/ai/conversations', { method: 'POST', body: '{}' });
    fakePrisma.messages.push({ id: 1, conversationId: 1, role: 'user', content: 'hi' });

    const res = await call('/api/ai/conversations/1', { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(fakePrisma.conversations.length, 0);
    assert.equal(fakePrisma.messages.length, 0);
  });

  it('查询别人的消息返回 404', async () => {
    await call('/api/ai/conversations', { method: 'POST', body: '{}' });
    const res = await call('/api/ai/conversations/1/messages', { userId: 2 });
    assert.equal(res.status, 404);
  });
});

describe('AI 接口 - 流式问答', () => {
  let fakePrisma: ReturnType<typeof createFakePrisma>;
  let server: { base: string; close: () => Promise<void> };
  let savedKey: string | undefined;

  beforeEach(async () => {
    // 明确模拟「没有配置模型 key」的环境：测试不依赖外网。
    // 注意 key 的实际变量名是 DEEPSEEK_API_KEY（resolveApiKey 只读它）；
    // 若这里删错变量名，本地 .env 里的真实 key 会让测试真的去请求模型。
    savedKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    fakePrisma = createFakePrisma();
    server = await startServer(fakePrisma);
  });

  afterEach(async () => {
    if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
    await server.close();
  });

  /** 把 SSE 响应解析成 { event, data } 列表 */
  async function readSse(response: Response) {
    const text = await response.text();
    const events: { event: string; data: any }[] = [];
    for (const block of text.split(/\n\n/)) {
      const lines = block.split('\n').filter(Boolean);
      if (!lines.length) continue;
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      events.push({
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length))
      });
    }
    return events;
  }

  const chat = (body: unknown, userId = 1) =>
    fetch(`${server.base}/api/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenOf(userId)}`
      },
      body: JSON.stringify(body)
    });

  it('空问题返回 400', async () => {
    const res = await chat({ question: '   ' });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error, '问题不能为空');
  });

  it('未登录返回 401', async () => {
    const res = await fetch(`${server.base}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '怎么上传文件' })
    });
    assert.equal(res.status, 401);
  });

  it('会话不存在时返回 404（不会开流）', async () => {
    const res = await chat({ question: '怎么上传文件', conversationId: 999 });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  });

  it('不带 conversationId 时自动建会话，并按问题生成标题', async () => {
    const res = await chat({ question: '怎么上传大文件？' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type')?.includes('text/event-stream'), true);

    const events = await readSse(res);
    const meta = events.find((item) => item.event === 'meta');
    assert.ok(meta);
    assert.equal(meta.data.title, '怎么上传大文件？');
    assert.ok(meta.data.conversationId > 0);
    // 首包只带会话信息，不再有知识库命中字段
    assert.equal(meta.data.sources, undefined);

    // 这个消息路径（会话 + 落库）与模型是否可用无关：
    // 没配 key 时由 error 事件收尾，同样要把一问一答写进历史
    const error = events.find((item) => item.event === 'error');
    assert.ok(error);
    assert.equal(events.some((item) => item.event === 'done'), false);

    // 消息已落库：一条 user + 一条 assistant
    assert.equal(fakePrisma.conversations.length, 1);
    assert.deepEqual(
      fakePrisma.messages.map((item) => item.role),
      ['user', 'assistant']
    );
  });

  it('没配模型 key 时明确报错，不再用本地资料编答案', async () => {
    const events = await readSse(await chat({ question: '怎么上传大文件？' }));
    const meta = events.find((item) => item.event === 'meta')!;
    assert.equal(meta.data.sources, undefined);

    const answer = events
      .filter((item) => item.event === 'delta')
      .map((item) => item.data.content)
      .join('');
    // 面向用户的文案不暴露实现细节：不出现变量名、服务商名、密钥前缀
    assert.equal(answer.includes('DEEPSEEK_API_KEY'), false);
    assert.equal(answer.includes('DEEPSEEK_MODEL'), false);
    assert.equal(answer.includes('DeepSeek'), false);
    assert.equal(answer.includes('sk-'), false);
    assert.equal(answer.includes('.env'), false);
    // 但仍要给出可操作的信息
    assert.ok(answer.includes('尚未配置'));
    assert.ok(answer.includes('管理员'));

    const error = events.find((item) => item.event === 'error');
    assert.ok(error);
    assert.equal(error.data.error, answer);
    // 出错时不发 done，前端走 onError 分支
    assert.equal(events.some((item) => item.event === 'done'), false);
  });

  it('模型不可用时仍把用户消息与错误说明落库，历史里没有空洞', async () => {
    const res = await chat({ question: '红烧肉怎么做' });
    const events = await readSse(res);
    const error = events.find((item) => item.event === 'error');
    assert.ok(error);
    assert.ok(error.data.error.trim().length > 0);

    const conversationId = events.find((item) => item.event === 'meta')!.data.conversationId;
    const list = fakePrisma.messages.filter((item) => item.conversationId === conversationId);
    assert.deepEqual(
      list.map((item) => item.role),
      ['user', 'assistant']
    );
    assert.equal(list[0]!.content, '红烧肉怎么做');
  });

  it('多轮对话会带上历史消息（第二问沿用同一会话）', async () => {
    const first = await readSse(await chat({ question: '怎么上传大文件？' }));
    const conversationId = first.find((item) => item.event === 'meta')!.data.conversationId;

    await readSse(await chat({ question: '那断点续传呢？', conversationId }));

    const list = fakePrisma.messages.filter((item) => item.conversationId === conversationId);
    assert.deepEqual(
      list.map((item) => item.role),
      ['user', 'assistant', 'user', 'assistant']
    );
    // 会话没有被重复创建
    assert.equal(fakePrisma.conversations.length, 1);
  });

  it('聊天后会话列表按活跃时间倒序返回，可恢复历史消息', async () => {
    const events = await readSse(await chat({ question: '普通成员能看到哪些菜单' }));
    const conversationId = events.find((item) => item.event === 'meta')!.data.conversationId;

    const listRes = await fetch(`${server.base}/api/ai/conversations`, {
      headers: { Authorization: `Bearer ${tokenOf(1)}` }
    });
    const list: any = await listRes.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, conversationId);
    assert.equal(list[0].messageCount, 2);

    const msgRes = await fetch(`${server.base}/api/ai/conversations/${conversationId}/messages`, {
      headers: { Authorization: `Bearer ${tokenOf(1)}` }
    });
    const messages: any = await msgRes.json();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, '普通成员能看到哪些菜单');
    assert.equal(messages[1].role, 'assistant');
  });
});

