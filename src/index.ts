// ============================================================
// 后端入口文件 - 这是整个后端的"总开关"
// 后端的作用：接收前端发来的请求，处理数据，返回结果
// 类比：前端是"餐厅前台"，后端是"厨房"
// ============================================================

// ---------- 导入依赖 ----------
// dotenv：读取 .env 文件里的环境变量（比如数据库密码）
import 'dotenv/config';
// express：Node.js 最流行的 Web 框架，用来创建 HTTP 服务器
import express from 'express';
// cors：允许前端跨域访问（不同端口之间通信需要它）
import cors from 'cors';
// PrismaClient：数据库操作工具（ORM），让你用代码操作 MySQL
import { PrismaClient } from '@prisma/client';
// 说明：JWT 的签发 / 校验已统一抽到 ./token.ts（双 token 方案），
//      这里不再直接使用 jsonwebtoken，避免密钥与过期时间散落多处。
// bcryptjs：密码加密工具（不能明文存密码）
import bcrypt from 'bcryptjs';
// 大文件分片上传相关接口（秒传 / 分片 / 合并 / 文件列表）
import { registerUploadRoutes } from './upload';
// 文件分类接口（列表 / 新建 / 修改 / 删除）
import { registerCategoryRoutes } from './category';
// AI 答疑接口（会话历史 + 流式问答）
import { registerAiRoutes } from './ai';
// RAG 知识库接口（文档上传 / 列表 / 删除 / 检索调试）
import { registerKnowledgeRoutes } from './knowledgeRoutes';
// JWT 鉴权中间件（抽到 auth.ts，上传接口等模块共用）
// JWT_SECRET 也一并从 auth.ts 导入，保证签发与校验用的是同一份密钥
import { authMiddleware, type AuthRequest } from './auth';
// 双 token：访问令牌 30 分钟 / 刷新令牌 7 天（签发与校验逻辑见 token.ts）
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  hashToken,
  signAccessToken,
  verifyToken
} from './token';
// 刷新令牌的数据库操作：一人一条，登录时删旧建新
import {
  findValidRefreshToken,
  issueRefreshToken,
  revokeRefreshToken
} from './refreshToken';
// 新密码强度校验（抽到 password.ts，方便单元测试，且与前端表单规则保持一致）
import { validateNewPassword } from './password';
// 分页参数解析（抽到 pagination.ts，方便单元测试，任务列表等接口共用）
import { parsePageParams, isPaginated } from './pagination';

// ---------- 创建应用实例 ----------
// 创建一个 Express 应用，后面所有接口都挂在这个 app 上
const app = express();
// 后端服务监听的端口号（前端通过 Vite 代理转发到这里）
// 支持环境变量覆盖：默认仍是 3000，本地起多套服务或用脚本做端到端验证时不用改代码
const port = Number(process.env.PORT) || 3000;
// 说明：JWT 密钥 JWT_SECRET 已统一由 ./auth.ts 导出，这里直接复用，
// 不再单独读一次环境变量，避免两处默认值不一致导致「签发成功但校验失败」。

// ---------- 中间件（请求进来先经过这里） ----------
// cors()：允许跨域请求（前端 5177 端口访问后端 3000 端口）
app.use(cors());
// express.json()：把前端发来的 JSON 数据解析成 req.body 对象
// 比如前端发 {"account":"abc","password":"123"}，req.body 就能拿到
app.use(express.json());

// ---------- 创建数据库连接 ----------
// 创建 Prisma 客户端实例，用它来操作 MySQL 数据库
const prisma = new PrismaClient();

// ============================================================
// JWT 鉴权中间件 - 验证用户是否已登录
// 作用：检查请求头里的 token，如果有效就把 userId 放到 req 上
// 用法：在需要登录才能访问的接口上加上这个中间件
// 注意：实现已抽到 ./auth.ts，这里直接导入使用（上传接口也复用它）
//      AuthRequest 类型同样来自 auth.ts，值为 number（数据库自增 id）
// ============================================================
// 扩展 Express 的 Request 类型，加上 userId 字段（已在 ./auth.ts 中定义并导出）

// ============================================================
// 认证接口 - 注册 / 登录 / 获取用户信息
// ============================================================

// ---------- 注册接口 ----------
// app.post('/api/auth/register', 处理函数)
// 前端调用：POST /api/auth/register，body 传 {account, password}
app.post('/api/auth/register', async (req, res) => {
  try {
    // 1. 从请求体里取出用户名和密码
    const { account, password } = req.body;
    // 2. 校验：用户名和密码不能为空
    if (!account || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    // 3. 查数据库：这个用户名是否已存在
    // prisma.user.findUnique = 按唯一字段查找用户
    const existing = await prisma.user.findUnique({ where: { account } });
    if (existing) {
      return res.status(400).json({ error: '用户名已存在' });
    }

    // 4. 密码加密（bcrypt.hash 第二个参数 10 是加密强度）
    // 绝对不能明文存密码！数据库泄露了密码就全暴露了
    const hashedPassword = await bcrypt.hash(password, 10);
    // 5. 创建用户，存到数据库
    // prisma.user.create = 插入一条新记录
    const user = await prisma.user.create({
      data: { account, password: hashedPassword }
    });

    // 6. 生成双 token（登录凭证）
    //    token：访问令牌，30 分钟，前端放请求头
    //    refreshToken：刷新令牌，7 天，存数据库，访问令牌过期后用它静默换新
    const token = signAccessToken(user.id);
    const refreshToken = await issueRefreshToken(prisma, user.id);

    // 7. 返回给前端：token + 用户信息（注意：不返回密码！）
    res.json({
      token,
      refreshToken,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
      user: { id: user.id, account: user.account }
    });
  } catch (error) {
    // 任何异常都返回 500（服务器内部错误）
    res.status(500).json({ error: '注册失败' });
  }
});

// ---------- 登录接口 ----------
// 前端调用：POST /api/auth/login，body 传 {account, password}
app.post('/api/auth/login', async (req, res) => {
  try {
    // 1. 取出用户名和密码
    const { account, password } = req.body;
    if (!account || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    // 2. 查数据库：找到这个用户
    const user = await prisma.user.findUnique({ where: { account } });
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 3. 验证密码：把用户输入的密码和数据库里加密的密码比对
    // bcrypt.compare(明文密码, 加密密码) 返回 true/false
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    // 4. 密码正确，生成双 token
    //    访问令牌 30 分钟；刷新令牌 7 天，并且会先删掉该用户之前的那条记录
    //    （一人一条：换设备/重新登录时，旧设备的刷新令牌立即失效）
    const token = signAccessToken(user.id);
    const refreshToken = await issueRefreshToken(prisma, user.id);

    // 5. 返回 token + 用户信息
    // role：当前登录人的角色（数据库字段，默认 "member"），前端据此做权限控制
    // mustChangePassword：是否还在用初始密码（新建成员 / 管理员重置后为 true），
    //   前端据此提示「请尽快修改密码」，引导成员去右上角「修改密码」
    res.json({
      token,
      refreshToken,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
      user: {
        id: user.id,
        account: user.account,
        role: user.role,
        mustChangePassword: user.mustChangePassword
      },
      role: user.role,
      mustChangePassword: user.mustChangePassword
    });
  } catch (error) {
    res.status(500).json({ error: '登录失败' });
  }
});

// ============================================================
// 双 token：刷新 / 登出
//
// 前端无感刷新流程：
//   1. 请求带访问令牌，返回 401 且 code === 'TOKEN_EXPIRED'；
//   2. 自动调 POST /api/auth/refresh，body 传 { refreshToken }；
//   3. 拿到新的访问令牌，重放刚才失败的请求，用户完全无感。
//
// 刷新时会「轮换」刷新令牌（旧的立即作废、下发新的），
// 这样刷新令牌在 7 天窗口内也不是一个长期不变的固定值。
// ============================================================

// ---------- 刷新访问令牌 ----------
// 前端调用：POST /api/auth/refresh，body 传 { refreshToken }
// 说明：这个接口【不】经过 authMiddleware —— 访问令牌已经过期了才需要刷新，
//      再要求带有效访问令牌就没法自举了。鉴权完全依赖数据里的刷新令牌记录。
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return res.status(400).json({ error: '缺少刷新令牌' });
    }

    // 1. 校验签名 + 类型（必须确实是 refresh 类型的令牌）
    const payload = verifyToken(refreshToken, 'refresh');
    if (!payload) {
      return res.status(401).json({ error: '刷新令牌无效或已过期，请重新登录', code: 'REFRESH_INVALID' });
    }

    // 2. 校验数据库记录：存在、摘要匹配、未过期
    //    记录不存在 = 已被新登录覆盖，或已登出 → 一律要求重新登录
    const record = await findValidRefreshToken(prisma, payload.userId, refreshToken);
    if (!record) {
      return res.status(401).json({ error: '登录状态已失效，请重新登录', code: 'REFRESH_REVOKED' });
    }

    // 3. 确认用户还在（防止用户被删后令牌仍能续期）
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, account: true, role: true, mustChangePassword: true }
    });
    if (!user) {
      await revokeRefreshToken(prisma, payload.userId);
      return res.status(401).json({ error: '用户不存在，请重新登录', code: 'USER_NOT_FOUND' });
    }

    // 4. 签发新访问令牌，并轮换刷新令牌（删旧建新）
    const token = signAccessToken(user.id);
    const nextRefreshToken = await issueRefreshToken(prisma, user.id);

    res.json({
      token,
      refreshToken: nextRefreshToken,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
      // 顺带把最新的用户信息（角色 / 是否需改密）返回，前端可同步更新
      user
    });
  } catch (error) {
    res.status(500).json({ error: '刷新登录状态失败' });
  }
});

// ---------- 退出登录 ----------
// 前端调用：POST /api/auth/logout，body 传 { refreshToken }
// 作用：删除数据库里的刷新令牌，让这个登录态彻底作废。
// 不加 authMiddleware：访问令牌可能已经过期，但用户仍应能「退出」。
app.post('/api/auth/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (typeof refreshToken === 'string' && refreshToken) {
      // 只删「这个令牌对应的用户」的记录，避免别人拿任意 token 清空别人登录态
      const payload = verifyToken(refreshToken, 'refresh');
      if (payload) {
        const record = await prisma.refreshToken.findUnique({ where: { userId: payload.userId } });
        if (record && record.tokenHash === hashToken(refreshToken)) {
          await revokeRefreshToken(prisma, payload.userId);
        }
      }
    }
    // 登出总是返回成功：前端无论如何都要清本地登录态
    res.json({ message: '已退出登录' });
  } catch (error) {
    res.status(500).json({ error: '退出登录失败' });
  }
});

// ---------- 获取当前用户信息 ----------
// 注意：这个接口加了 authMiddleware，需要登录才能访问
// 前端调用：GET /api/auth/profile，请求头带 Authorization: Bearer xxx
app.get('/api/auth/profile', authMiddleware, async (req: AuthRequest, res) => {
  try {
    // req.userId 是 authMiddleware 验证 token 后放上去的
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: '未登录' });
    }

    // 查数据库：按 id 找用户，只返回必要字段（不返回密码）
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, account: true, role: true, mustChangePassword: true, createdAt: true }
    });
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: '获取用户信息失败' });
  }
});

// ============================================================
// 密码自助管理接口（登录后即可使用，普通成员也能操作自己的账号）
//   PUT /api/auth/password  修改密码：校验旧密码 → 设新密码
// 注意：接口只作用于「当前登录人」，不接受前端传 id，从 token 取 userId，
//      从根本上避免越权改别人密码。
// 已移除「自助重置」：普通成员不能自己重置密码。
//   忘记密码 → 由管理员在成员管理中重置（PUT /api/resetPassword/:id）
// ============================================================

// ---------- 修改自己的密码 ----------
// 前端调用：PUT /api/auth/password，body 传 { oldPassword, newPassword }
app.put('/api/auth/password', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId
    if (!userId) {
      return res.status(401).json({ error: '未登录' })
    }

    const { oldPassword, newPassword } = req.body || {}

    if (typeof oldPassword !== 'string' || !oldPassword) {
      return res.status(400).json({ error: '请输入原密码' })
    }
    // 统一用 validateNewPassword 做强度校验，错误文案直接给前端展示
    const invalidReason = validateNewPassword(newPassword)
    if (invalidReason) {
      return res.status(400).json({ error: invalidReason })
    }
    if (oldPassword === newPassword) {
      return res.status(400).json({ error: '新密码不能与原密码相同' })
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true }
    })
    if (!user) {
      return res.status(404).json({ error: '用户不存在' })
    }

    // 校验原密码，防止别人拿到 token 后直接改密
    const valid = await bcrypt.compare(oldPassword, user.password)
    if (!valid) {
      return res.status(400).json({ error: '原密码错误' })
    }

    const hashedPassword = await bcrypt.hash(String(newPassword), 10)
    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        // 本人主动改过密码 → 不再是初始密码，取消「必须改密」标记
        mustChangePassword: false
      }
    })

    // 密码已变更，顺手作废刷新令牌：其他地方（比如被盗的旧设备）不能再续期，
    // 只能拿新密码重新登录。当前设备的访问令牌 30 分钟内仍有效，体验不受影响。
    await revokeRefreshToken(prisma, userId)

    res.json({ message: '密码修改成功，请使用新密码重新登录' })
  } catch (error) {
    res.status(500).json({ error: '修改密码失败' })
  }
})

// ============================================================
// 任务接口 - 增删改查（全部需要登录）
// ============================================================

// ---------- 查询任务（支持分页） ----------
// 前端调用：
//   GET /api/tasks                     → 返回 Task[]（全量，看板 / 上传页下拉用）
//   GET /api/tasks?page=1&pageSize=10  → 返回 { list, total, page, pageSize }（任务管理表格用）
app.get('/api/tasks', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: '未登录' });
    }

    // 管理员看全部任务，普通成员只看自己的任务
    const roleData = await prisma.user.findFirst({
      where: { id: userId }
    });
    const where = roleData?.role === 'admin' ? {} : { userId };

    // 前端没传 page 时保持老行为（返回数组），避免看板、上传页等依赖全量列表的地方被改坏
    if (!isPaginated(req.query.page)) {
      const tasks = await prisma.task.findMany({
        where,
        orderBy: { createdAt: 'desc' }
      });
      return res.json(tasks);
    }

    // 分页参数兜底：非法值统一按第一页 / 默认条数处理，单页上限防止一次拉太多
    const { page, pageSize, skip, take } = parsePageParams(
      req.query.page,
      req.query.pageSize
    );

    // 权限条件必须同时用在 count 和 findMany 上，
    // 否则普通成员拿到的 total 会把别人的任务也算进来
    const [total, list] = await prisma.$transaction([
      prisma.task.count({ where }),
      prisma.task.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take
      })
    ]);

    return res.json({ list, total, page, pageSize });
  } catch (error) {
    res.status(500).json({ error: '查询任务失败' });
  }
});


//前端调用查询用户列表：Get /api/userList
app.get('/api/userList',authMiddleware,async(req:AuthRequest,res)=>{
  const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: '未登录' });
    }

  try{
    const userName = req.query.userName ? String(req.query.userName) : undefined;
    // 支持按姓名或账号搜索（两者任一包含关键字即可）
    // 注意：schema.prisma 里的字段名是小写的 account，写成 userName 会抛 Prisma 校验错误
    const where:any = userName
      ? {
          OR: [
            { username: { contains: userName } },
            { account: { contains: userName } }
          ]
        }
      : {}
    const userList = await prisma.user.findMany({where, orderBy: { id: 'asc' }})
    // 只返回前端需要的字段，不暴露 password 哈希
    // account 来自数据库的 account（登录账号），userName 是姓名（username）
    res.json(userList.map((user) => ({
      id: user.id,
      role:user.role,
      account: user.account,
      userName: user.username ?? '',
      age: user.age,
      email: user.email ?? ''
    })))
  }catch(error){
    res.status(500).json({error:'查询用户列表失败'})
  }
})

// ---------- 新增任务 ----------
// 前端调用：POST /api/tasks，body 传 {title, status?, priority?}
app.post('/api/tasks', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: '未登录' });
    }

    // 从请求体取数据（status 和 priority 有默认值，可以不传）
    const { title, status, priority,description } = req.body;
    if (!title) {
      return res.status(400).json({ error: '标题不能为空' });
    }

    // 插入数据库：创建一条新任务，关联到当前用户
    const newTask = await prisma.task.create({
      data: {
        title,
        userId,
        description:description||'',
        status: status || 'todo',      // 默认状态：待办
        priority: priority || 'medium' // 默认优先级：中
      }
    });
    res.json(newTask);
  } catch (error) {
    res.status(500).json({ error: '创建任务失败' });
  }
});

//生成随机密码
function generatePassword(length = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let password = ''
  for (let i = 0; i < length; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return password
}

// ---------- 密码规则校验（改密接口统一使用） ----------
// 实现已抽到 ./password.ts：便于单元测试，且 index.ts 一旦被 import 就会连数据库、起服务，
// 不适合直接对里面的私有函数做单测。
// validateNewPassword 在文件顶部 import 进来，这里直接使用。

//新增用户 
app.post('/api/addUser',authMiddleware,async (req:AuthRequest,res)=>{
  try{
     const userId = req.userId;
     if(!userId){
      return res.status(401).json({error:'未登录'})
     }
   
     const account = String(req.body?.account ?? req.body?.account ?? '').trim();
     const username = req.body?.userName ? String(req.body.userName).trim() : '';
     const {age,email} = req.body;
     const password = generatePassword(10);
     if(!account){
      return res.status(400).json({error:'账号不能为空'})
     }
     // password 在 schema.prisma 里是必填字段（String，非 String?），
     // 不传就会触发 TS2322，所以这里必须校验
    //  if(!password){
    //   return res.status(400).json({error:'密码不能为空'})
    //  }
     // 账号唯一，先查重，否则会抛 Prisma P2002 唯一约束错误
     const existing = await prisma.user.findUnique({ where: {  account } });
     if (existing) {
      return res.status(400).json({error:'账号已存在'})
     }
     // 和注册接口一样，密码必须加密后再入库
     const hashedPassword = await bcrypt.hash(String(password), 10);
     const newUser =await prisma.user.create({
      data:{
          account: account,
          password: hashedPassword,
          username: username ,
          // age / email 在 schema 里是可空字段（Int? / String?），对应 Prisma 类型是 number|null / string|null。
          // 本项目 tsconfig 开了 exactOptionalPropertyTypes: true，
          // 它禁止把 undefined 传给声明为 number|null 的属性，所以“空值”必须显式写 null
          age: age === undefined || age === null || age === '' ? null : Number(age),
          email: email ? String(email) : null,
          // 新建成员拿到的是系统生成的初始密码 → 首次登录提示修改
          mustChangePassword: true
      }

     })
     // 不要返回 password 哈希（和注册接口口径一致）
     res.json({
       id: newUser.id,
       account: newUser.account,
       password:password,
       userName: newUser.username ?? '',
       age: newUser.age,
       email: newUser.email ?? ''
     })

   }catch(error){
      res.status(500).json({error:'新建成员失败'})
   }
})

//修改用户 put 
app.put('/api/updateUser',authMiddleware,async(req:AuthRequest,res)=>{
   try{
    const userId  = req.userId;
    if(!userId){
      return res.status(401).json({error:'未登录'})
    }
    // account = 登录账号（对应数据库 account 字段，唯一）
    // userName = 姓名（对应数据库 userName 字段）
    // password 留空表示不修改密码
    const { account, userName, age, email, id } = req.body;
    const existing = await prisma.user.findFirst({
      where:{id}
    })
    if (!existing) {
      return res.status(404).json({ error: '用户不存在' });
    }
    // 账号变化时要校验唯一性，否则会抛 Prisma P2002
    const nextAccount = account !== undefined ? String(account).trim() : (account !== undefined ? String(account).trim() : undefined);
    if (nextAccount !== undefined) {
      if (!nextAccount) {
        return res.status(400).json({ error: '账号不能为空' });
      }
      if (nextAccount !== existing.account) {
        const duplicated = await prisma.user.findUnique({ where: { account: nextAccount } });
        if (duplicated) {
          return res.status(400).json({ error: '账号已存在' });
        }
      }
    }
    //更新数据库
    // 注意：字段名必须是 schema.prisma 里定义的 account（小写 n），
    // 写成 userName 会触发 TS2561（对象字面量里没有这个属性）
    // age / email / username 不传时保持数据库原值，不要用 0 / 空串覆盖
    // 密码只有传了非空值才更新，且同样要加密
    // const nextPassword = password ? await bcrypt.hash(String(password), 10) : undefined;
    const updateUser =await prisma.user.update(
      {where:{id},data:{
        ...(nextAccount !== undefined && { account: nextAccount }),
        ...(userName !== undefined && { username: userName === '' ? null : String(userName) }),
        ...(age !== undefined && age !== null && age !== '' && { age: Number(age) }),
        ...(email !== undefined && { email: email === '' ? null : String(email) }),
        // ...(nextPassword !== undefined && { password: nextPassword })
      }}
    )
    // 不要返回 password 哈希（和注册 / 新增用户接口口径一致）
    res.json({
      id: updateUser.id,
      account: updateUser.account,
      userName: updateUser.username ?? '',
      age: updateUser.age,
      email: updateUser.email ?? ''
    })

   }catch(error){
    res.status(500).json({error:'修改用户信息失败'})
   }

})
//重置密码
// 权限规则（修复越权漏洞）：
//   - 普通成员只能重置「自己」的密码（id 必须等于 token 里的 userId）
//   - 管理员可以重置任何人的密码
// 语义：管理员重置 = 发一个新初始密码；成员重置自己 = 同样发新初始密码，
//       两者都会把 mustChangePassword 置 true，下次登录会提示改密。
app.put('/api/resetPassword/:id',authMiddleware,async(req:AuthRequest,res)=>{
   try{
    const userId = req.userId;
    if(!userId){
      return res.status(401).json({error:'未登录'})
    }
    const id =parseInt(String(req.params.id));
    if(Number.isNaN(id)){
      return res.status(400).json({error:'用户 id 不合法'})
    }

    // 取操作人角色 + 目标用户，一次查完
    const [operator, existing] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { role: true } }),
      prisma.user.findUnique({ where: { id } })
    ])
    if(!operator){
      return res.status(401).json({error:'登录状态已失效，请重新登录'})
    }
    if(!existing){
      return res.status(404).json({error:'用户不存在'})
    }
    // 关键权限校验：非管理员只能重置自己的密码
    const isAdmin = operator.role === 'admin'
    if(!isAdmin && id !== userId){
      return res.status(403).json({error:'无权重置其他用户的密码'})
    }

    const password = generatePassword(10);
    const hashedPassword = await bcrypt.hash(String(password), 10);
    await prisma.user.update(
      {where:{id},data:{
        password: hashedPassword,
        // 重置后是新的初始密码 → 下次登录提示修改
        mustChangePassword: true
      }}
    )
    // 管理员重置了别人的密码后，那个人的旧登录态必须立即作废，
    // 否则被重置的账号仍能靠旧刷新令牌一直续期。
    await revokeRefreshToken(prisma, id)
    res.json({
      password:password,
      account:existing.account
    })
    
   }catch(error){
     res.status(500).json({error:'重置密码失败'})

   }
})

//删除用户
app.delete('/api/deleteUser/:id',authMiddleware,async(req:AuthRequest,res)=>{
   try{
    const userId  = req.userId;
    if(!userId){
      return res.status(401).json({error:'未登录'})
    }
    const id = parseInt(String(req.params.id));
    const existing = await prisma.user.findFirst({
      where:{id}
    })
    if (!existing) {
      return res.status(404).json({ error: '用户不存在' });
    }
     await prisma.task.updateMany({
      where:{userId:Number(id),status:'doing'},
      data:{status:'todo',completedPerson:'',userId:null}
    })
    //删除数据库
    await prisma.user.delete(
      {where:{id:Number(id)}}
    )   
    res.json({message:"删除成功"})
   }catch(error){
    res.status(500).json({error:'删除用户失败'})
   }

})

// ---------- 更新任务 ----------
// 前端调用：PUT /api/tasks/:id，body 传 {title?, status?, priority?}
// :id 是 URL 里的参数，比如 /api/tasks/5 表示更新 id=5 的任务
app.put('/api/tasks/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: '未登录' });
    }

    // 从 URL 里取出任务 id（req.params.id 是字符串，要转成数字）
    const taskId = parseInt(String(req.params.id));
    // completedPerson：分配任务时记录接收人姓名；description 也一并支持修改
    const { title, status, priority, description, completedPerson ,userId:relationId} = req.body;

    // 安全检查：先确认这个任务属于当前用户
    // 防止用户 A 修改用户 B 的任务
    // 例外：管理员可以操作任意任务（任务列表管理页里管理员看到的是所有人的任务）
    const currentUser = await prisma.user.findFirst({ where: { id: userId } });
    const isAdmin = currentUser?.role === 'admin';
    const existing = await prisma.task.findFirst({
      where: isAdmin ? { id: taskId } : { id: taskId, userId }
    });
    if (!existing) {
      return res.status(404).json({ error: '任务不存在' });
    }
    if (relationId !== undefined && !isAdmin) {
      return res.status(403).json({ error: '仅管理员可分配任务' });
    }

    // 更新数据库：只更新传了值的字段
    // ...(title !== undefined && { title }) 的意思是：
    // 如果 title 有值，就把它加进更新对象里
    const updatedTask = await prisma.task.update({
      where: { id: taskId },
      data: {
        ...(title !== undefined && { title }),
        ...(status !== undefined && { status }),
        ...(priority !== undefined && { priority }),
        ...(description !== undefined && { description }),
        ...(completedPerson !== undefined && { completedPerson }),
          // ✨ 分配任务：如果是管理员且传了新的负责人ID，则建立关联
        ...(relationId !== undefined && { 
          user: { connect: { id: relationId } } 
        }),

      }
    });
    res.json(updatedTask);
  } catch (error) {
    res.status(500).json({ error: '更新任务失败' });
  }
});

// ---------- 删除任务 ----------
// 前端调用：DELETE /api/tasks/:id
// app.delete('/api/tasks/:id', authMiddleware, async (req: AuthRequest, res) => {
//   try {
//     const userId = req.userId;
//     if (!userId) {
//       return res.status(401).json({ error: '未登录' });
//     }

//     const taskId = parseInt(String(req.params.id));

//     // 安全检查：确认任务属于当前用户
//     const existing = await prisma.task.findFirst({
//       where: { id: taskId, userId }
//     });
//     if (!existing) {
//       return res.status(404).json({ error: '任务不存在' });
//     }

//     // 从数据库删除
//     await prisma.task.delete({ where: { id: taskId } });
//     res.json({ message: '删除成功' });
//   } catch (error) {
//     res.status(500).json({ error: '删除任务失败' });
//   }
// });

//删除任务
app.delete('/api/tasks/:id',authMiddleware,async (req:AuthRequest,res)=>{
  try{
    const userId = req.userId;
    if(!userId){
      return res.status(401).json({error:"未登录"})
    }
    const taskId = parseInt(String(req.params.id));
    //安全检查：确认任务属于当前用户
    const existing = await prisma.task.findFirst({
      where:{id:taskId,userId:userId}
    });
    if(!existing){
      return res.status(404).json({error:'任务不存在'})
    }
    //从数据库删除
    await prisma.task.delete({where:{id:taskId}})
    res.json({message:"删除成功"})

  }catch(error){
     res.status(500).json({error:'删除任务失败'})
  }
})

// ============================================================
// 大文件上传接口（/api/upload/*）
// 注意：必须在 app.listen 之前注册
// 需要 prisma：上传时校验「文件分类 / 任务」是否存在，并记录上传人
// ============================================================
registerUploadRoutes(app, prisma);

// ============================================================
// 文件分类接口（/api/categories）
// 复用同一个 prisma 实例，同样必须在 app.listen 之前注册
// ============================================================
registerCategoryRoutes(app, prisma);

// ============================================================
// RAG 知识库接口（/api/knowledge/*）
// 文档上传建索引 / 列表 / 删除 / 检索调试
// 注意：必须注册在 registerAiRoutes 之前或之后都无影响（路径不冲突），
// 但 /api/ai/chat 内部会调用 knowledgeRoutes 的 searchDocs 做检索。
// ============================================================
registerKnowledgeRoutes(app, prisma);

// ============================================================
// AI 答疑接口（/api/ai/*）
// 会话列表 / 新建 / 重命名 / 删除 / 消息列表 / 流式问答
// ============================================================
registerAiRoutes(app, prisma);

// ---------- 测试接口 ----------
// 浏览器访问 http://localhost:3000/ 就能看到
app.get('/', (req, res) => {
  res.send('✅ 后端服务跑通了！');
});

// ---------- 启动服务器 ----------
// app.listen(端口, 回调) - 开始监听端口，等待请求进来
app.listen(port, () => {
  console.log(`✅ 后端服务已启动: http://localhost:${port}`);
});
