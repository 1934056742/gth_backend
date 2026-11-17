import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import {
  decodeFileName,
  extractText,
  getExt,
  makeChunkRows,
  parseMultipartWithFile,
  registerKnowledgeRoutes,
  searchDocs,
  SUPPORTED_EXTS,
  type KnowledgeRoutesPrisma
} from './knowledgeRoutes.ts';

/**
 * 手搓一个最小合法 PDF（单页，Helvetica 字体，一行文本）
 *
 * 为什么不用现成的 pdf 文件：仓库里不想塞二进制测试资源；
 * 这个结构足够 pdfjs 解析出文字，用于验证「解析链路通不通」，
 * 顺带验证分页噪音已被关掉。
 */
function buildPdf(line: string): Buffer {
  const content = `BT /F1 12 Tf 20 100 Td (${line}) Tj ET`;
  const stream = `stream\n${content}\nendstream`;
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      `4 0 obj<</Length ${content.length}>>${stream}endobj`,
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      'trailer<</Root 1 0 R>>',
      '%%EOF'
    ].join('\n'),
    'latin1'
  );
}

/**
 * 手搓一个最小可用的 .docx（本质是 zip）
 *
 * 为什么不引 jszip：为了一个测试再装个依赖不划算。
 * 这里只用 zip 的 STORE（不压缩）模式 —— 不需要实现 deflate，
 * 只要 CRC32 + 本地文件头 + 中央目录三段结构正确，mammoth 就能读。
 */
function buildDocx(paragraph: string): Buffer {
  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const files: { name: string; data: Buffer }[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
        'utf-8'
      )
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
        'utf-8'
      )
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          `<w:body><w:p><w:r><w:t>${escapeXml(paragraph)}</w:t></w:r></w:p></w:body>` +
          '</w:document>',
        'utf-8'
      )
    }
  ];

  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    return table;
  })();

  const crc32 = (buf: Buffer): number => {
    let crc = -1;
    for (let i = 0; i < buf.length; i += 1) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]!) & 0xff]!;
    }
    return (crc ^ -1) >>> 0;
  };

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf-8');
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 需要版本
    local.writeUInt16LE(0, 6); // 标志位
    local.writeUInt16LE(0, 8); // 压缩方法 0 = STORE
    local.writeUInt16LE(0, 10); // 修改时间
    local.writeUInt16LE(0x21, 12); // 修改日期（1980-01-01，固定值即可）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // 压缩后大小（STORE 时等于原始大小）
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    nameBuf.copy(local, 30);

    locals.push(local, file.data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 需要版本
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头偏移
    nameBuf.copy(central, 46);

    centrals.push(central);
    offset += local.length + size;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 中央目录结束签名
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...locals, centralBuf, end]);
}

/**
 * 知识库接口测试
 *
 * 覆盖三层：
 *   1. 纯函数：扩展名识别、文本解码、切块入库、multipart 解析、文件名还原；
 *   2. 检索：内存版 Prisma + 真实 HTTP，验证「只召回自己的文档」；
 *   3. 接口：上传 / 列表 / 删除 / 权限隔离，走真实鉴权中间件。
 *
 * 运行：npm test
 */

// ---------- 内存版 Prisma（只实现 knowledgeRoutes.ts 用到的 delegate） ----------
function createFakePrisma() {
  const users: any[] = [];
  const docs: any[] = [];
  const chunks: any[] = [];
  let docSeq = 0;
  let chunkSeq = 0;

  /** 支持 where.id / where.ownerId / where.docId.in 三种形态 */
  const matchWhere = (row: any, where: any = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && 'in' in (value as any)) {
        return (value as any).in.includes(row[key]);
      }
      return row[key] === value;
    });

  return {
    users,
    docs,
    chunks,
    user: {
      async findFirst({ where }: any = {}) {
        return users.find((row) => matchWhere(row, where)) ?? null;
      }
    },
    knowledgeDoc: {
      async findMany({ where }: any = {}) {
        return docs.filter((row) => matchWhere(row, where));
      },
      /** 带 owner 关联的查询：真实 Prisma 通过 relation 返回，这里手工拼一份 */
      async findFirst({ where, select }: any = {}) {
        const row = docs.find((item) => matchWhere(item, where));
        if (!row) return null;
        if (!select?.owner) return row;
        const owner = users.find((user) => user.id === row.ownerId) ?? null;
        return { ...row, owner };
      },
      async create({ data }: any) {
        docSeq += 1;
        const row = { id: docSeq, createdAt: new Date(), ...data };
        docs.push(row);
        return row;
      },
      async delete({ where }: any) {
        const index = docs.findIndex((row) => matchWhere(row, where));
        assert.ok(index >= 0, '要删除的文档必须存在');
        const [removed] = docs.splice(index, 1);
        // 模拟数据库的 onDelete: Cascade
        for (let i = chunks.length - 1; i >= 0; i -= 1) {
          if (chunks[i].docId === (removed as any).id) chunks.splice(i, 1);
        }
        return removed;
      }
    },
    knowledgeChunk: {
      async findMany({ where }: any = {}) {
        return chunks.filter((row) => matchWhere(row, where));
      },
      // 详情接口用它统计实际切块数（可选能力，测试里也实现一份以便校验）
      async count({ where }: any = {}) {
        return chunks.filter((row) => matchWhere(row, where)).length;
      },
      async createMany({ data }: any) {
        for (const item of data) {
          chunkSeq += 1;
          chunks.push({ id: chunkSeq, ...item });
        }
        return { count: data.length };
      },
      async deleteMany({ where }: any = {}) {
        const before = chunks.length;
        for (let i = chunks.length - 1; i >= 0; i -= 1) {
          if (matchWhere(chunks[i], where)) chunks.splice(i, 1);
        }
        return { count: before - chunks.length };
      }
    }
  };
}

// ---------- 测试辅助 ----------
const JWT_SECRET = process.env.JWT_SECRET || 'geek-task-hub-secret';

function tokenOf(userId: number): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

/**
 * 手工拼一个 multipart/form-data 请求体
 *
 * 用 Buffer 拼接而不是模板字符串：中文文件名/正文必须按 UTF-8 编码，
 * 字符串拼接可能会在 Buffer.from 时出错，用 Buffer 更贴近浏览器真实请求。
 */
function buildMultipart(fileName: string, content: string, boundary = 'test-boundary-9527') {
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    'Content-Type: text/plain\r\n\r\n';
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([Buffer.from(head, 'utf-8'), Buffer.from(content, 'utf-8'), Buffer.from(tail, 'utf-8')])
  };
}

async function startServer(fakePrisma: ReturnType<typeof createFakePrisma>) {
  const app = express();
  // 不用 express.json：上传接口自己读原始 body
  app.use((req, res, next) => {
    if (/^\/api\/knowledge\/search$/.test(req.path)) return express.json()(req, res, next);
    return next();
  });
  registerKnowledgeRoutes(app, fakePrisma as unknown as KnowledgeRoutesPrisma);

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


describe('getExt - 扩展名识别', () => {
  it('取小写扩展名', () => {
    assert.equal(getExt('说明.MD'), 'md');
    assert.equal(getExt('a.b.txt'), 'txt');
  });

  it('无扩展名 / 隐藏文件 / 以点结尾时返回空串', () => {
    assert.equal(getExt('README'), '');
    assert.equal(getExt('.gitignore'), '');
    assert.equal(getExt('trailing.'), '');
    assert.equal(getExt(''), '');
  });
});

describe('extractText - 文本解码', () => {
  it('UTF-8 文本正常读取，并去掉 BOM', async () => {
    const result = await extractText('a.txt', Buffer.from('\uFEFF第一行\r\n第二行', 'utf-8'));
    assert.equal(result.ok, true);
    assert.ok(result.ok && result.text.startsWith('第一行'));
  });

  it('不支持的格式给出可读提示（含支持列表）', async () => {
    const result = await extractText('简历.xlsx', Buffer.from('whatever', 'utf-8'));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes('.xlsx'));
    assert.ok(!result.ok && result.error.includes('docx'));
  });

  it('.doc 旧格式提示另存为 docx', async () => {
    const result = await extractText('旧简历.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes('.docx'));
  });

  it('支持的格式列表包含 docx 与 pdf', () => {
    assert.ok(SUPPORTED_EXTS.includes('docx'));
    assert.ok(SUPPORTED_EXTS.includes('pdf'));
    assert.ok(SUPPORTED_EXTS.includes('txt'));
    assert.ok(!SUPPORTED_EXTS.includes('doc'));
  });

  it('非 UTF-8 编码直接拒绝，不写入乱码', async () => {
    // 0xC4 0xE3 是 GBK 的「你」，单独出现时不是合法 UTF-8
    const result = await extractText('gbk.txt', Buffer.from([0xc4, 0xe3, 0xba, 0xc3]));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes('UTF-8'));
  });

  it('空白文件视为空内容', async () => {
    const result = await extractText('empty.txt', Buffer.from('  \n\n  ', 'utf-8'));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes('为空'));
  });

  it('损坏的 docx 给出可读提示而不是抛异常', async () => {
    const result = await extractText('broken.docx', Buffer.from('not a zip file', 'utf-8'));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes('Word'));
  });

  it('损坏的 pdf 给出可读提示而不是抛异常', async () => {
    const result = await extractText('broken.pdf', Buffer.from('%PDF-1.4 garbage', 'utf-8'));
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes('PDF'));
  });
});

describe('extractText - 真实 docx 解析', () => {
  it('docx 能抽出正文文字', async () => {
    const bytes = buildDocx('上传失败了怎么办？请检查文件大小。');
    const result = await extractText('手册.docx', bytes);
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    assert.ok(result.ok && result.text.includes('上传失败'));
  });
});

describe('extractText - 真实 pdf 解析', () => {
  it('pdf 能抽出文字，且不带分页噪音', async () => {
    const result = await extractText('说明.pdf', buildPdf('Upload failed'));
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    assert.ok(result.ok && result.text.includes('Upload failed'));
    // getText 默认会在页尾插 "-- 1 of 1 --"，必须被关掉
    assert.ok(result.ok && !/--\s*\d+\s+of\s+\d+\s*--/.test(result.text));
  });
});

describe('makeChunkRows - 切块入库', () => {
  it('序号从 0 递增，且带分词结果', () => {
    const rows = makeChunkRows('第一段内容。\n\n第二段内容。');
    assert.ok(rows.length >= 1);
    assert.equal(rows[0]!.seq, 0);
    for (let i = 0; i < rows.length; i += 1) {
      assert.equal(rows[i]!.seq, i);
      assert.ok(rows[i]!.tokenCount > 0, '每块都应有词条');
      assert.equal(rows[i]!.tokens.split(' ').filter(Boolean).length, rows[i]!.tokenCount);
    }
  });
});

describe('parseMultipartWithFile - multipart 解析', () => {
  it('能取出字段与文件（含中文文件名）', () => {
    const boundary = 'xyz';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n备注\r\n`,
        'utf-8'
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="使用说明.md"\r\n\r\n正文内容\r\n`,
        'utf-8'
      ),
      Buffer.from(`--${boundary}--\r\n`, 'utf-8')
    ]);

    const { fields, file } = parseMultipartWithFile(body, `multipart/form-data; boundary=${boundary}`);
    assert.equal(fields.note, '备注');
    assert.ok(file);
    assert.equal(file!.name, '使用说明.md');
    // 末尾的 \r\n 属于分隔符，不应混进正文
    assert.equal(file!.data.toString('utf-8'), '正文内容');
  });

  it('没有文件时 file 为 null', () => {
    const boundary = 'abc';
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--${boundary}--\r\n`, 'utf-8');
    const { fields, file } = parseMultipartWithFile(body, `multipart/form-data; boundary=${boundary}`);
    assert.equal(fields.a, '1');
    assert.equal(file, null);
  });

  it('缺少 boundary 时不抛错，返回空结果', () => {
    const { fields, file } = parseMultipartWithFile(Buffer.from('x'), 'multipart/form-data');
    assert.deepEqual(fields, {});
    assert.equal(file, null);
  });
});

describe('decodeFileName - 文件名还原', () => {
  it('普通文件名原样返回', () => {
    assert.equal(decodeFileName('说明.md'), '说明.md');
  });

  it('百分号编码的文件名会被解码', () => {
    assert.equal(decodeFileName('%E8%AF%B4%E6%98%8E.md'), '说明.md');
  });

  it('非法编码不抛错，原样返回', () => {
    assert.equal(decodeFileName('%E8%ZZ'), '%E8%ZZ');
  });
});


describe('知识库接口 - 上传 / 列表 / 删除', () => {
  /** 建一个「普通用户 1 + 管理员 2 + 普通用户 3」的环境 */
  function seed() {
    const fake = createFakePrisma();
    fake.users.push(
      { id: 1, username: '小明', account: 'ming', role: 'user' },
      { id: 2, username: '管理员', account: 'admin', role: 'admin' },
      { id: 3, username: '小红', account: 'hong', role: 'user' }
    );
    return fake;
  }

  it('未登录访问任一接口都返回 401', async () => {
    const fake = seed();
    const server = await startServer(fake);
    try {
      const list = await fetch(`${server.base}/api/knowledge/docs`);
      assert.equal(list.status, 401);

      const { contentType, body } = buildMultipart('a.txt', '内容');
      const upload = await fetch(`${server.base}/api/knowledge/docs`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body
      });
      assert.equal(upload.status, 401);

      const remove = await fetch(`${server.base}/api/knowledge/docs/1`, { method: 'DELETE' });
      assert.equal(remove.status, 401);
    } finally {
      await server.close();
    }
  });

  it('上传成功：返回切块数，原文与切块都落库', async () => {
    const fake = seed();
    const server = await startServer(fake);
    try {
      const { contentType, body } = buildMultipart('使用说明.md', '# 标题\n\n这是正文内容。');
      const response = await fetch(`${server.base}/api/knowledge/docs`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, Authorization: `Bearer ${tokenOf(1)}` },
        body
      });

      assert.equal(response.status, 201);
      const doc: any = await response.json();
      assert.equal(doc.fileName, '使用说明.md');
      assert.ok(doc.chunkCount >= 1);
      assert.equal(fake.docs.length, 1);
      assert.equal(fake.chunks.length, doc.chunkCount);
      assert.equal(fake.docs[0].ownerId, 1);
    } finally {
      await server.close();
    }
  });

  it('上传不支持的格式返回 400，且不写库', async () => {
    const fake = seed();
    const server = await startServer(fake);
    try {
      const { contentType, body } = buildMultipart('表格.xlsx', 'whatever');
      const response = await fetch(`${server.base}/api/knowledge/docs`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, Authorization: `Bearer ${tokenOf(1)}` },
        body
      });
      assert.equal(response.status, 400);
      const data: any = await response.json();
      assert.ok(String(data.error).includes('.xlsx'));
      assert.equal(fake.docs.length, 0);
    } finally {
      await server.close();
    }
  });


  it('列表：普通成员只看自己的，管理员看全部', async () => {
    const fake = seed();
    const server = await startServer(fake);
    try {
      const upload = async (userId: number, name: string) => {
        const { contentType, body } = buildMultipart(name, `这是 ${name} 的内容。`);
        return fetch(`${server.base}/api/knowledge/docs`, {
          method: 'POST',
          headers: { 'Content-Type': contentType, Authorization: `Bearer ${tokenOf(userId)}` },
          body
        });
      };
      await upload(1, '小明的笔记.txt');
      await upload(3, '小红的笔记.txt');

      const mine = await fetch(`${server.base}/api/knowledge/docs`, {
        headers: { Authorization: `Bearer ${tokenOf(1)}` }
      });
      const mineList = (await mine.json()) as any[];
      assert.equal(mineList.length, 1);
      assert.equal(mineList[0].fileName, '小明的笔记.txt');
      assert.equal(mineList[0].canDelete, true);

      const all = await fetch(`${server.base}/api/knowledge/docs`, {
        headers: { Authorization: `Bearer ${tokenOf(2)}` }
      });
      const allList = (await all.json()) as any[];
      assert.equal(allList.length, 2);
      assert.ok(allList.every((doc) => doc.canDelete === true), '管理员可删除任意文档');
    } finally {
      await server.close();
    }
  });

  it('删除：他人文档返回 404（不暴露是否存在），本人可删且级联删切块', async () => {
    const fake = seed();
    const server = await startServer(fake);
    try {
      const { contentType, body } = buildMultipart('笔记.txt', '内容内容内容。');
      const created = await fetch(`${server.base}/api/knowledge/docs`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, Authorization: `Bearer ${tokenOf(1)}` },
        body
      });
      const doc: any = await created.json();

      // 用户 3 删用户 1 的文档
      const denied = await fetch(`${server.base}/api/knowledge/docs/${doc.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOf(3)}` }
      });
      assert.equal(denied.status, 404);

      // 不存在的 id
      const missing = await fetch(`${server.base}/api/knowledge/docs/9999`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOf(1)}` }
      });
      assert.equal(missing.status, 404);

      // 本人删除成功，切块一并清掉
      const ok = await fetch(`${server.base}/api/knowledge/docs/${doc.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tokenOf(1)}` }
      });
      assert.equal(ok.status, 200);
      assert.equal(fake.docs.length, 0);
      assert.equal(fake.chunks.length, 0);
    } finally {
      await server.close();
    }
  });

  it('查看详情：本人可看到解析后的正文与会话信息', async () => {
    const fake = seed();
    const server = await startServer(fake);
    try {
      const { contentType, body } = buildMultipart('操作手册.md', '# 上传\n\n请点击上传按钮。');
      const created = await fetch(`${server.base}/api/knowledge/docs`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, Authorization: `Bearer ${tokenOf(1)}` },
        body
      });
      const doc: any = await created.json();

      const detail = await fetch(`${server.base}/api/knowledge/docs/${doc.id}`, {
        headers: { Authorization: `Bearer ${tokenOf(1)}` }
      });
      assert.equal(detail.status, 200);
      const data: any = await detail.json();
      assert.equal(data.id, doc.id);
      assert.equal(data.fileName, '操作手册.md');
      assert.ok(data.content.includes('请点击上传按钮'), '应返回解析后的正文');
      assert.equal(data.charCount, data.content.length);
      assert.equal(data.chunkCount, doc.chunkCount, '切块数与列表一致');
      assert.equal(data.ownerName, '小明');
      assert.equal(data.canDelete, true);
      assert.equal(data.truncated, false);
    } finally {
      await server.close();
    }
  });

  it('查看详情：他人文档 404，管理员可查看；不存在 / 非法 id 也有明确状态码', async () => {
    const fake = seed();
    const server = await startServer(fake);
    try {
      const { contentType, body } = buildMultipart('笔记.txt', '这是正文内容。');
      const created = await fetch(`${server.base}/api/knowledge/docs`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, Authorization: `Bearer ${tokenOf(1)}` },
        body
      });
      const doc: any = await created.json();

      // 用户 3 不在列表里能看到它，改 URL 直接打开也必须被拒
      const denied = await fetch(`${server.base}/api/knowledge/docs/${doc.id}`, {
        headers: { Authorization: `Bearer ${tokenOf(3)}` }
      });
      assert.equal(denied.status, 404);

      // 管理员可以查看任意人的文档
      const byAdmin = await fetch(`${server.base}/api/knowledge/docs/${doc.id}`, {
        headers: { Authorization: `Bearer ${tokenOf(2)}` }
      });
      assert.equal(byAdmin.status, 200);
      const adminData: any = await byAdmin.json();
      assert.ok(adminData.content.includes('正文内容'));
      // 别人的文档：管理员可删，但不是「我」上传的
      assert.equal(adminData.canDelete, true);

      // 不存在的 id
      const missing = await fetch(`${server.base}/api/knowledge/docs/9999`, {
        headers: { Authorization: `Bearer ${tokenOf(1)}` }
      });
      assert.equal(missing.status, 404);

      // 非法 id
      const invalid = await fetch(`${server.base}/api/knowledge/docs/abc`, {
        headers: { Authorization: `Bearer ${tokenOf(1)}` }
      });
      assert.equal(invalid.status, 400);
    } finally {
      await server.close();
    }
  });

  it('查看详情：未登录返回 401', async () => {
    const fake = seed();
    const server = await startServer(fake);
    try {
      const response = await fetch(`${server.base}/api/knowledge/docs/1`);
      assert.equal(response.status, 401);
    } finally {
      await server.close();
    }
  });
});

describe('searchDocs - 检索可见范围', () => {
  it('只召回自己的文档，别人的内容不会出现在结果里', async () => {
    const fake = createFakePrisma();
    fake.users.push({ id: 1, role: 'user' }, { id: 2, role: 'user' });
    await fake.knowledgeDoc.create({
      data: { ownerId: 1, fileName: '我的手册.txt', fileSize: 10, content: '', charCount: 10, chunkCount: 1 }
    });
    await fake.knowledgeDoc.create({
      data: { ownerId: 2, fileName: '别人的手册.txt', fileSize: 10, content: '', charCount: 10, chunkCount: 1 }
    });
    await fake.knowledgeChunk.createMany({
      data: [
        { docId: 1, seq: 0, content: '上传文件时请点击上传按钮。', tokens: '上传 传文 文件 按钮', tokenCount: 4 },
        { docId: 2, seq: 0, content: '上传文件需要管理员审核。', tokens: '上传 传文 文件 管理 审核', tokenCount: 5 }
      ]
    });

    const hits = await searchDocs(fake as unknown as KnowledgeRoutesPrisma, 1, '上传文件');
    assert.ok(hits.length > 0);
    assert.ok(hits.every((hit) => hit.docId === 1), '不能检索到他人的文档');
    assert.equal(hits[0]!.fileName, '我的手册.txt');
    assert.ok(hits[0]!.content.includes('上传按钮'), '应带上完整原文供拼上下文');
  });

  it('知识库为空时返回空数组', async () => {
    const fake = createFakePrisma();
    fake.users.push({ id: 1, role: 'user' });
    const hits = await searchDocs(fake as unknown as KnowledgeRoutesPrisma, 1, '任何问题');
    assert.deepEqual(hits, []);
  });
});
