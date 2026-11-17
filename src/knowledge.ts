/**
 * RAG 知识库的文本处理与检索（纯函数，无 IO，便于单测）
 *
 * 整体链路：
 *   原文 → normalizeText → splitIntoChunks（切块）→ tokenize（分词）→ 落库
 *   提问 → tokenize → scoreChunks（BM25）→ Top-K → 拼进 prompt
 *
 * 为什么用 BM25 而不是向量检索：
 *   1. DeepSeek 目前没有开放 Embedding 接口，做向量检索还得再引入一家的 key；
 *   2. 本项目的知识库是操作手册 / 规章制度类资料，术语固定，关键词召回已经够用；
 *   3. 零额外调用成本、结果可解释（能说清命中了哪些词）。
 *   检索层刻意做成「输入 chunks + 查询词，输出带分数的片段」的纯函数，
 *   以后想换成向量检索，只需要替换 scoreChunks 的实现。
 *
 * 关于中文分词：
 *   不引入 nodejieba 等依赖（需要本地编译，部署麻烦），改用「二元切分」：
 *   连续汉字切成相邻两字的组合（"文件上传" → 文件/件上/上传），
 *   外加英文单词 / 数字整体保留。二元切分对中文检索的召回效果接近词级分词，
 *   且不需要维护词典。
 */

/** 一个待检索的切块（与数据库 KnowledgeChunk 字段对应） */
export interface ChunkRecord {
  docId: number;
  seq: number;
  content: string;
  tokens: string[];
  tokenCount: number;
}

/** 检索结果：片段 + 归属信息 + BM25 分数 */
export interface SearchHit {
  docId: number;
  seq: number;
  content: string;
  score: number;
}

// ---------- 可调参数 ----------

/** 切块长度（字符）：太小会切断语义，太大导致召回内容冗长、白烧 token */
export const CHUNK_SIZE = Number(process.env.RAG_CHUNK_SIZE || 400);
/** 相邻切块的重叠字符数：保证被切断的句子在前后两块里都完整出现 */
export const CHUNK_OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP || 80);
/** 召回条数：默认 4 条，够回答一个问题又不至于把 prompt 撑爆 */
export const TOP_K = Number(process.env.RAG_TOP_K || 4);
/** 低于该分数的片段视为不相关，直接丢弃（避免把无关内容塞给模型引发幻觉） */
export const MIN_SCORE = Number(process.env.RAG_MIN_SCORE || 0.5);
/** 单次问答最多带入的上下文总字符数 */
export const MAX_CONTEXT_CHARS = Number(process.env.RAG_MAX_CONTEXT_CHARS || 2000);

// BM25 标准参数：k1 控制词频饱和，b 控制文档长度归一化强度（业界常用取值）
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** 极高频的功能字，切出这些二元词只会带来噪声 */
const STOP_TOKENS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '也', '都', '就', '而', '及', '等',
  '这', '那', '有', '我', '你', '他', '它', '们', '个', '之', '为', '以', '于',
  'the', 'a', 'an', 'of', 'to', 'in', 'is', 'are', 'and', 'or', 'for', 'on', 'at'
]);

/**
 * 统一换行、去掉零宽字符、压缩多余空白。
 * 保留换行是有意的：切块时按段落切更自然。
 */
export function normalizeText(input: string): string {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u0000/g, '')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 中文友好的分词：汉字二元切分 + 英文/数字整词保留
 *
 * 例：
 *   "文件上传失败 怎么处理" → 文件/件上/上传/传失/失败/怎么/么处/处理
 *   "upload_file 报错"      → upload/file/报错
 *
 * 为什么保留英文整词：报错信息、字段名、函数名基本都是英文，
 * 整词比二元切分精确得多（upload 不该被拆成 up、pl、lo 这种碎片）。
 */
export function tokenize(input: string): string[] {
  const text = String(input ?? '').toLowerCase();
  if (!text) return [];

  const tokens: string[] = [];

  // 英文单词 / 数字 / 下划线连写，整体作为一个词；汉字串单独切出来做二元组合
  const re = /[a-z0-9_]+|[\u4e00-\u9fa5]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const piece = match[0];
    if (/^[a-z0-9_]/.test(piece)) {
      // 少于 2 个字符的英文（如 a、9）没有检索价值
      if (piece.length >= 2 && !STOP_TOKENS.has(piece)) tokens.push(piece);
      continue;
    }
    // 单个汉字
    if (piece.length === 1) {
      if (!STOP_TOKENS.has(piece)) tokens.push(piece);
      continue;
    }
    // 二元切分：相邻两字组合，能覆盖绝大多数中文检索需求
    for (let i = 0; i < piece.length - 1; i += 1) {
      const bigram = piece.slice(i, i + 2);
      if (!STOP_TOKENS.has(bigram)) tokens.push(bigram);
    }
  }

  return tokens;
}

/** 把分词结果还原成数据库存的空格分隔字符串 */
export function tokensToString(tokens: string[]): string {
  return tokens.join(' ');
}

/** 把数据库里存的 tokens 字符串解析回数组（容忍多空格） */
export function stringToTokens(value: string): string[] {
  return String(value ?? '').split(' ').filter(Boolean);
}

/**
 * 把长文本切成若干块，优先在段落 / 句子边界断开
 *
 * 策略：
 *   1. 先按空行拆段落，段落本身超长再按句子拆，句子还超长就硬切；
 *   2. 相邻块保留 CHUNK_OVERLAP 个字符的重叠，避免一句话被切成两半后
 *      两边都读不出完整意思；
 *   3. 空白块直接丢弃。
 */
export function splitIntoChunks(
  text: string,
  size: number = CHUNK_SIZE,
  overlap: number = CHUNK_OVERLAP
): string[] {
  const source = normalizeText(text);
  if (!source) return [];
  // 防御非法参数：overlap 必须小于 size，否则切块会原地打转（死循环）
  const chunkSize = Math.max(50, size);
  const safeOverlap = Math.max(0, Math.min(overlap, Math.floor(chunkSize / 2)));

  const chunks: string[] = [];
  let start = 0;

  while (start < source.length) {
    // 先取一个不超过 chunkSize 的窗口
    let end = Math.min(start + chunkSize, source.length);

    if (end < source.length) {
      // 在窗口后半段找一个「断点」，让块尽量结束在句号 / 换行处
      const windowStart = start + Math.floor(chunkSize * 0.6);
      const window = source.slice(windowStart, end);
      const breakMatch = [...window.matchAll(/[。！？；\n]/g)].pop();
      if (breakMatch && breakMatch.index !== undefined) {
        end = windowStart + breakMatch.index + 1;
      }
    }

    const piece = source.slice(start, end).trim();
    if (piece) chunks.push(piece);

    if (end >= source.length) break;
    // 下一块的起点回退 overlap 个字符，形成重叠
    start = Math.max(end - safeOverlap, start + 1);
  }

  return chunks;
}


/**
 * BM25 检索
 *
 * BM25 的三件事：
 *   1. TF：查询词在片段里出现越多分越高，但有饱和（k1），避免某个词刷分；
 *   2. IDF：越少见的词越有区分度（"上传" 比 "文件" 值钱）；
 *   3. 长度归一化（b）：长片段天然容易命中，要适当降权。
 *
 * @param chunks   全部候选片段（生产环境按可见范围先查出来，再交给这里打分）
 * @param query    用户问题原文
 * @param topK     返回条数
 * @param minScore 低于该分数丢弃
 */
export function scoreChunks(
  chunks: ChunkRecord[],
  query: string,
  topK: number = TOP_K,
  minScore: number = MIN_SCORE
): SearchHit[] {
  if (!chunks.length) return [];

  const queryTokens = [...new Set(tokenize(query))];
  if (!queryTokens.length) return [];

  const total = chunks.length;
  const avgLength =
    chunks.reduce((sum, item) => sum + (item.tokenCount || item.tokens.length || 0), 0) / total || 1;

  // 先算每个查询词的 IDF（文档频率来自候选集本身）
  const idf = new Map<string, number>();
  for (const term of queryTokens) {
    let df = 0;
    for (const chunk of chunks) {
      if (chunk.tokens.includes(term)) df += 1;
    }
    if (!df) continue; // 全集里没出现过的词直接跳过
    // 标准 BM25 IDF，加 1 保证非负
    idf.set(term, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
  }
  if (!idf.size) return [];

  const hits: SearchHit[] = [];
  for (const chunk of chunks) {
    const length = chunk.tokenCount || chunk.tokens.length || 0;
    let score = 0;
    for (const term of queryTokens) {
      const termIdf = idf.get(term);
      if (!termIdf) continue;
      // 该词在片段里出现的次数（tokens 是数组，含重复）
      let tf = 0;
      for (const token of chunk.tokens) {
        if (token === term) tf += 1;
      }
      if (!tf) continue;
      const denominator = tf + BM25_K1 * (1 - BM25_B + (BM25_B * length) / avgLength);
      score += termIdf * ((tf * (BM25_K1 + 1)) / denominator);
    }
    if (score <= 0 || score < minScore) continue;
    hits.push({ docId: chunk.docId, seq: chunk.seq, content: chunk.content, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(1, topK));
}

/** 检索结果里的片段来源，用于回答下方展示「参考来源」 */
export interface SourceRef {
  docId: number;
  fileName: string;
  seq: number;
  score: number;
  snippet: string;
}

/**
 * 把检索到的片段拼成给模型的上下文文本。
 *
 * 带上编号与文件名是必要的：
 *   - 编号让模型能按 [1][2] 引用，前端据此做溯源展示；
 *   - 文件名本身就含信息（"上传操作手册.md"），能帮模型判断该不该采信。
 */
export function buildContextBlock(
  hits: SearchHit[],
  fileNameOf: (docId: number) => string,
  maxChars: number = MAX_CONTEXT_CHARS
): { text: string; sources: SourceRef[] } {
  if (!hits.length) return { text: '', sources: [] };

  const parts: string[] = [];
  const sources: SourceRef[] = [];
  let used = 0;

  hits.forEach((hit, index) => {
    const fileName = fileNameOf(hit.docId) || `文档${hit.docId}`;
    const head = `[${index + 1}] 来源：${fileName}（第 ${hit.seq + 1} 段）\n`;
    // 超出预算就截断这一段，而不是整段丢弃（半段也比没有强）
    const remain = maxChars - used - head.length;
    if (remain <= 80) return;
    const body = hit.content.length > remain ? `${hit.content.slice(0, remain)}…` : hit.content;
    parts.push(`${head}${body}`);
    used += head.length + body.length;
    sources.push({
      docId: hit.docId,
      fileName,
      seq: hit.seq,
      score: Number(hit.score.toFixed(3)),
      // 列表展示用短摘要，避免前端渲染超长文本
      snippet: hit.content.length > 120 ? `${hit.content.slice(0, 120)}…` : hit.content
    });
  });

  return { text: parts.join('\n\n'), sources };
}

/**
 * 把「资料上下文」注入 system prompt。
 *
 * 防幻觉是这里最重要的事：明确要求「只依据资料回答、资料里没有就说不知道」，
 * 否则模型会拿自己的先验知识硬答，用户还以为是文档里的内容。
 */
export function buildRagSystemPrompt(basePrompt: string, context: string): string {
  if (!context) return basePrompt;
  return [
    basePrompt,
    '',
    '以下是用户上传的资料片段，请优先依据这些资料回答，并在引用处标注来源编号（如 [1]、[2]）：',
    '--- 资料开始 ---',
    context,
    '--- 资料结束 ---',
    '如果资料中没有相关信息，请明确说明「资料中未提及」，不要编造。'
  ].join('\n');
}

