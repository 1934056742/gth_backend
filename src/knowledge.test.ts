import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText,
  tokenize,
  tokensToString,
  stringToTokens,
  splitIntoChunks,
  scoreChunks,
  buildContextBlock,
  buildRagSystemPrompt,
  type ChunkRecord
} from './knowledge.ts';

/**
 * RAG 知识库文本处理测试
 *
 * 规则来源：src/knowledge.ts
 *   原文 → normalizeText → splitIntoChunks → tokenize →（落库）
 *   提问 → tokenize → scoreChunks(BM25) → buildContextBlock → buildRagSystemPrompt
 *
 * 设计要点：
 *   不引入分词依赖（nodejieba 需要本地编译），改用汉字二元切分，
 *   所以这里重点验证「二元切分 + 英文整词」的行为是否符合预期。
 */

/** 构造一个切块，tokens 由内容自动算出，模拟入库时的状态 */
function makeChunk(docId: number, seq: number, content: string): ChunkRecord {
  const tokens = tokenize(content);
  return { docId, seq, content, tokens, tokenCount: tokens.length };
}

describe('normalizeText', () => {
  it('统一换行符并去掉零宽字符', () => {
    const input = '第一行\r\n第二行\u200B\r第三行';
    assert.equal(normalizeText(input), '第一行\n第二行\n第三行');
  });

  it('压缩连续空行与行内多余空格', () => {
    assert.equal(normalizeText('a   b\n\n\n\nc'), 'a b\n\nc');
  });

  it('空输入返回空串（不抛错）', () => {
    assert.equal(normalizeText(''), '');
    assert.equal(normalizeText(undefined as unknown as string), '');
  });
});

describe('tokenize（中文二元切分）', () => {
  it('连续汉字切成相邻二字组合', () => {
    // "文件上传" → 文件 / 件上 / 上传
    assert.deepEqual(tokenize('文件上传'), ['文件', '件上', '上传']);
  });

  it('英文与数字整体保留，不做二元切分', () => {
    const tokens = tokenize('upload_file 报错 404');
    assert.ok(tokens.includes('upload_file'), '下划线连写应整体保留');
    assert.ok(tokens.includes('404'), '数字应整体保留');
    assert.ok(tokens.includes('报错'));
    // 不应把 upload 拆成 up / pl / lo
    assert.ok(!tokens.includes('up'));
  });

  it('过滤停用词，减少噪声', () => {
    const tokens = tokenize('的文件');
    // "的" 是停用词，但 "文件" 必须保留
    assert.ok(tokens.includes('文件'));
    assert.ok(!tokens.includes('的'));
  });

  it('大小写不敏感', () => {
    assert.deepEqual(tokenize('Upload'), tokenize('upload'));
  });

  it('空字符串返回空数组', () => {
    assert.deepEqual(tokenize(''), []);
  });
});

describe('tokens 与字符串互转', () => {
  it('往返转换保持一致', () => {
    const tokens = ['文件', '上传', 'upload'];
    const text = tokensToString(tokens);
    assert.equal(text, '文件 上传 upload');
    assert.deepEqual(stringToTokens(text), tokens);
  });

  it('解析时容忍多余空格', () => {
    assert.deepEqual(stringToTokens('文件  上传 '), ['文件', '上传']);
  });
});

describe('splitIntoChunks（切块）', () => {
  /** 造一段足够长的中文文本，句子之间用句号分隔 */
  function longText(sentenceCount: number): string {
    return Array.from({ length: sentenceCount }, (_, i) => `这是第${i + 1}个测试句子用于验证切块逻辑`).join(
      '。'
    );
  }

  it('短文本不切块，原样返回一条', () => {
    const chunks = splitIntoChunks('很短的一句话', 400, 80);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], '很短的一句话');
  });

  it('长文本被切成多块，且每块不超过设定长度太多', () => {
    const chunks = splitIntoChunks(longText(40), 200, 40);
    assert.ok(chunks.length > 1, '长文本应被切块');
    // 允许在断点处略微超出，但不能到两倍
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 400, `块长度 ${chunk.length} 超出预期`);
    }
  });

  it('相邻块有重叠内容，避免句子被从中间切断', () => {
    const chunks = splitIntoChunks(longText(40), 200, 60);
    assert.ok(chunks.length >= 2);
    const first = chunks[0] ?? '';
    const second = chunks[1] ?? '';
    // 前一块的结尾应当能到后一块的开头里找到（重叠）
    const tail = first.slice(-20);
    assert.ok(second.includes(tail), '相邻切块之间应有重叠内容');
  });

  it('尽量在句号处断开（不在句子中间硬切）', () => {
    const text = `${'甲'.repeat(100)}。${'乙'.repeat(100)}。${'丙'.repeat(100)}。`;
    const chunks = splitIntoChunks(text, 150, 0);
    // 除最后一块外，前面的块应以句号结尾
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const chunk = chunks[i] ?? '';
      assert.ok(chunk.endsWith('。'), `第 ${i + 1} 块应在句号处结束，实际结尾：${chunk.slice(-5)}`);
    }
  });

  it('空白文本返回空数组', () => {
    assert.deepEqual(splitIntoChunks('   \n\n  '), []);
  });

  it('overlap 不小于 size 时不会死循环', () => {
    const chunks = splitIntoChunks(longText(10), 100, 500);
    assert.ok(chunks.length > 0);
    assert.ok(chunks.length < 100, '必须能正常终止');
  });
});

describe('scoreChunks（BM25 检索）', () => {
  const chunks: ChunkRecord[] = [
    makeChunk(1, 0, '如何上传文件：点击上传按钮，选择文件后确认即可。'),
    makeChunk(1, 1, '删除任务需要管理员权限，点击删除按钮并二次确认。'),
    makeChunk(2, 0, '系统支持 mp4、pdf、docx 等多种文件格式。'),
    makeChunk(2, 1, '修改密码请进入个人设置页面，输入原密码与新密码。')
  ];

  it('能召回与问题相关的片段', () => {
    const hits = scoreChunks(chunks, '怎么上传文件', 4, 0);
    assert.ok(hits.length > 0, '应命中相关片段');
    const top = hits[0]!;
    assert.equal(top.docId, 1);
    assert.equal(top.seq, 0);
    assert.ok(top.content.includes('上传'));
  });

  it('按相关度倒序，最相关的排第一', () => {
    const hits = scoreChunks(chunks, '删除任务', 4, 0);
    assert.equal(hits[0]!.seq, 1, '关于「删除任务」的片段应排第一');
    for (let i = 1; i < hits.length; i += 1) {
      assert.ok(hits[i - 1]!.score >= hits[i]!.score, '分数必须单调不增');
    }
  });

  it('完全无关的问题返回空结果（不做兜底召回）', () => {
    const hits = scoreChunks(chunks, '量子纠缠的贝尔不等式', 4, 0);
    assert.deepEqual(hits, [], '无关问题不应硬凑片段给模型');
  });

  it('topK 限制返回条数', () => {
    const hits = scoreChunks(chunks, '文件', 2, 0);
    assert.ok(hits.length <= 2);
  });

  it('minScore 过滤低相关度片段', () => {
    const loose = scoreChunks(chunks, '文件', 10, 0);
    const strict = scoreChunks(chunks, '文件', 10, 100);
    assert.ok(strict.length <= loose.length, '提高阈值后召回数不应增加');
  });

  it('空候选集或空问题返回空数组', () => {
    assert.deepEqual(scoreChunks([], '上传文件'), []);
    assert.deepEqual(scoreChunks(chunks, '   '), []);
  });
});



describe('buildContextBlock（拼上下文）', () => {
  const hits = [
    { docId: 1, seq: 0, content: '如何上传文件：点击上传按钮。', score: 3.21 },
    { docId: 2, seq: 3, content: '支持的格式有 mp4 和 pdf。', score: 1.05 }
  ];
  const fileNameOf = (docId: number) => (docId === 1 ? '上传手册.md' : '格式说明.txt');

  it('带上编号、文件名与段号，便于模型引用与用户溯源', () => {
    const { text, sources } = buildContextBlock(hits, fileNameOf);
    assert.ok(text.includes('[1] 来源：上传手册.md（第 1 段）'));
    assert.ok(text.includes('[2] 来源：格式说明.txt（第 4 段）'));
    assert.equal(sources.length, 2);
    assert.equal(sources[0]!.fileName, '上传手册.md');
    assert.equal(sources[0]!.seq, 0);
    assert.equal(sources[0]!.score, 3.21);
  });

  it('超出字符预算时截断内容而不是整段丢弃', () => {
    const longHits = [{ docId: 1, seq: 0, content: '甲'.repeat(500), score: 2 }];
    const { text, sources } = buildContextBlock(longHits, fileNameOf, 200);
    assert.equal(sources.length, 1, '仍应保留来源信息');
    assert.ok(text.length <= 260, `上下文应被截断，实际长度 ${text.length}`);
    assert.ok(text.includes('…'), '截断应有省略号');
  });

  it('无命中时返回空上下文（不拼出空壳 prompt）', () => {
    const result = buildContextBlock([], fileNameOf);
    assert.equal(result.text, '');
    assert.deepEqual(result.sources, []);
  });

  it('文件名缺失时用文档 id 兜底', () => {
    const { text } = buildContextBlock([hits[0]!], () => '');
    assert.ok(text.includes('文档1'));
  });
});

describe('buildRagSystemPrompt（注入资料 + 防幻觉）', () => {
  const base = '你是 AI 答疑助手';

  it('有资料时把上下文注入，并明确要求标注来源', () => {
    const prompt = buildRagSystemPrompt(base, '[1] 来源：手册.md\n上传方法……');
    assert.ok(prompt.startsWith(base));
    assert.ok(prompt.includes('资料开始'));
    assert.ok(prompt.includes('上传方法'));
    assert.ok(prompt.includes('标注来源编号'));
  });

  it('资料为空时不改动原 prompt（避免无意义的空标签）', () => {
    assert.equal(buildRagSystemPrompt(base, ''), base);
  });

  it('包含「资料中没有就说明未提及」的防幻觉约束', () => {
    const prompt = buildRagSystemPrompt(base, 'context');
    assert.ok(prompt.includes('未提及'));
    assert.ok(prompt.includes('不要编造'));
  });
});
