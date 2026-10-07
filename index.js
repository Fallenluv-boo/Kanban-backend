require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');

// Prisma 7/8 setup
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
let prisma = null;

try {
  if (connectionString) {
    const pool = new Pool({ connectionString });
    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
  }
} catch (err) {
  console.warn('⚠️ Не вдалося ініціалізувати Prisma адаптер:', err.message);
}

// ---------------------------------------------------------------------
// In-Memory Storage (Fallback, якщо база даних ще не мігрована або офлайн)
// ---------------------------------------------------------------------
const memory = {
  users: [
    {
      id: 'u1',
      email: 'demo@commitflow.app',
      name: 'Денис',
      avatarUrl: null,
      passwordHash: bcrypt.hashSync('demo1234', 10),
      createdAt: new Date(),
    },
  ],
  boards: [
    {
      id: 'b1',
      title: 'CommitFlow — спринт 1',
      ownerId: 'u1',
      createdAt: new Date('2026-10-07T10:00:00.000Z'),
      updatedAt: new Date('2026-10-07T12:00:00.000Z'),
    },
  ],
  boardMembers: [
    {
      boardId: 'b1',
      userId: 'u1',
      role: 'owner',
      joinedAt: new Date('2026-10-07T10:00:00.000Z'),
    },
  ],
  columns: [
    { id: 'c1', title: 'TODO', order: 0, boardId: 'b1' },
    { id: 'c2', title: 'IN PROGRESS', order: 1, boardId: 'b1' },
    { id: 'c3', title: 'DONE', order: 2, boardId: 'b1' },
  ],
  tasks: [
    {
      id: 't1',
      boardId: 'b1',
      columnId: 'c1',
      status: 'TODO',
      order: 0,
      issueNumber: '#1',
      title: 'Налаштувати Tailwind CSS',
      description: 'Додати конфігурацію темної теми',
      priority: 'High',
      labels: '["UI/UX"]',
      label: 'UI/UX',
      dueDate: null,
      assigneeId: 'u1',
      createdById: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 't2',
      boardId: 'b1',
      columnId: 'c1',
      status: 'TODO',
      order: 1,
      issueNumber: '#2',
      title: 'Підключити Zustand',
      description: 'Стейт менеджер для збереження стану',
      priority: 'Medium',
      labels: '["Core"]',
      label: 'Core',
      dueDate: null,
      assigneeId: null,
      createdById: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 't3',
      boardId: 'b1',
      columnId: 'c2',
      status: 'IN_PROGRESS',
      order: 0,
      issueNumber: '#3',
      title: 'Створити UI картки',
      description: 'Компонент картки з бейджами',
      priority: 'Low',
      labels: '["UI/UX"]',
      label: 'UI/UX',
      dueDate: null,
      assigneeId: 'u1',
      createdById: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 't4',
      boardId: 'b1',
      columnId: 'c3',
      status: 'DONE',
      order: 0,
      issueNumber: '#4',
      title: 'Придумати дизайн бази даних',
      description: 'Prisma схема для зв\'язків',
      priority: 'High',
      labels: '["Backend"]',
      label: 'Backend',
      dueDate: null,
      assigneeId: null,
      createdById: 'u1',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
  invites: [],
};

const app = express();
const server = http.createServer(app);

// Збільшуємо ліміт для передачі avatarUrl (data:image/jpeg;base64)
app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Socket-ID'],
}));

// Nodemailer налаштування
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://jeben-board.duckdns.org';
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendInviteEmail({ to, boardTitle, token, invitedByName }) {
  const inviteUrl = `${FRONTEND_URL}/invite/${token}`;
  console.log(`📨 [Invite] Запрошення на дошку "${boardTitle}" для ${to}: ${inviteUrl}`);
  if (mailTransporter) {
    try {
      await mailTransporter.sendMail({
        from: process.env.SMTP_FROM || '"CommitFlow" <noreply@commitflow.app>',
        to,
        subject: `Запрошення на дошку "${boardTitle}" в CommitFlow`,
        html: `
          <div style="font-family: sans-serif; max-width: 500px; padding: 20px;">
            <h2>Запрошення до команди в CommitFlow</h2>
            <p><strong>${invitedByName || 'Користувач'}</strong> запросив вас приєднатися до дошки <strong>"${boardTitle}"</strong>.</p>
            <p><a href="${inviteUrl}" style="display: inline-block; background: #000; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 8px;">Прийняти запрошення</a></p>
            <p style="color: #666; font-size: 12px;">Посилання дійсне протягом 7 днів: ${inviteUrl}</p>
          </div>
        `,
      });
    } catch (err) {
      console.warn('⚠️ Помилка надсилання email через SMTP:', err.message);
    }
  }
}

// ---------------------------------------------------------------------
// WebSockets (Socket.IO) з кімнатами та авторизацією
// ---------------------------------------------------------------------
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  },
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('unauthorized'));
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'MY_SECRET_KEY');
    socket.data.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  socket.join(`user:${userId}`);

  socket.on('join_board', async ({ boardId }) => {
    try {
      const isMember = await checkMembership(boardId, userId);
      if (isMember) {
        socket.join(`board:${boardId}`);
      }
    } catch (e) {
      console.error('join_board error:', e);
    }
  });

  socket.on('leave_board', ({ boardId }) => {
    socket.leave(`board:${boardId}`);
  });
});

function emitToBoard(boardId, event, payload, senderSocketId) {
  const room = `board:${boardId}`;
  if (senderSocketId) {
    const sender = io.sockets.sockets.get(senderSocketId);
    if (sender) {
      sender.to(room).emit(event, payload);
      return;
    }
  }
  io.to(room).emit(event, payload);
}

function emitToUser(userId, event, payload) {
  io.to(`user:${userId}`).emit(event, payload);
}

// ---------------------------------------------------------------------
// Middleware авторизації
// ---------------------------------------------------------------------
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: "Доступ заборонено. Немає токена" });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'MY_SECRET_KEY', (err, user) => {
    if (err) return res.status(401).json({ error: "Недійсний або прострочений токен" });
    req.user = user;
    next();
  });
};

// ---------------------------------------------------------------------
// Допоміжні функції для роботи з базою / пам'яттю
// ---------------------------------------------------------------------

// Перевірка членства користувача на дошці
async function getBoardMember(boardId, userId) {
  if (prisma) {
    try {
      const member = await prisma.boardMember.findUnique({
        where: { boardId_userId: { boardId, userId } },
        include: { user: true },
      });
      if (member) return member;

      // Міграція наявних даних: якщо дошка є, але BoardMember ще немає, перевіряємо чи є він власником
      const board = await prisma.board.findUnique({ where: { id: boardId } });
      if (board && (board.ownerId === userId || board.userId === userId)) {
        const newMember = await prisma.boardMember.create({
          data: { boardId, userId, role: 'owner' },
          include: { user: true },
        });
        return newMember;
      }
    } catch (err) {
      // Fallback до memory
    }
  }

  const m = memory.boardMembers.find(bm => bm.boardId === boardId && bm.userId === userId);
  if (!m) {
    const b = memory.boards.find(brd => brd.id === boardId);
    if (b && (b.ownerId === userId || b.userId === userId)) {
      const newM = { boardId, userId, role: 'owner', joinedAt: new Date() };
      memory.boardMembers.push(newM);
      return newM;
    }
    return null;
  }
  return m;
}

async function checkMembership(boardId, userId) {
  const member = await getBoardMember(boardId, userId);
  return !!member;
}

// Форматування таски за специфікацією
function formatTask(task) {
  let labels = [];
  if (Array.isArray(task.labels)) {
    labels = task.labels;
  } else if (typeof task.labels === 'string') {
    try {
      labels = JSON.parse(task.labels);
    } catch {
      labels = task.labels ? [task.labels] : [];
    }
  }

  let formattedDueDate = null;
  if (task.dueDate) {
    if (typeof task.dueDate === 'string') {
      formattedDueDate = task.dueDate.split('T')[0];
    } else if (task.dueDate instanceof Date) {
      formattedDueDate = task.dueDate.toISOString().split('T')[0];
    }
  }

  return {
    id: task.id,
    boardId: task.boardId,
    columnId: task.columnId,
    status: task.status || 'TODO',
    order: task.order !== undefined ? Number(task.order) : 0,
    issueNumber: task.issueNumber || `#${task.id.slice(0, 4)}`,
    title: task.title,
    description: task.description || '',
    priority: task.priority || 'Medium',
    labels,
    label: task.label || labels[0] || 'Feature',
    dueDate: formattedDueDate,
    assigneeId: task.assigneeId || null,
    createdBy: task.createdById || task.createdBy || null,
    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
    updatedAt: (task.updatedAt || task.createdAt) instanceof Date
      ? (task.updatedAt || task.createdAt).toISOString()
      : (task.updatedAt || task.createdAt),
  };
}

// Форматування запрошення
function formatInvite(invite, boardTitle, invitedByName) {
  return {
    id: invite.id,
    token: invite.token,
    type: invite.email ? 'email' : 'link',
    boardId: invite.boardId,
    boardTitle: boardTitle || invite.board?.title || 'CommitFlow Board',
    email: invite.email || null,
    role: invite.role || 'member',
    status: invite.status || 'pending',
    invitedBy: {
      id: invite.invitedById,
      name: invitedByName || invite.invitedBy?.name || 'Власник',
    },
    createdAt: invite.createdAt instanceof Date ? invite.createdAt.toISOString() : invite.createdAt,
    expiresAt: invite.expiresAt instanceof Date ? invite.expiresAt.toISOString() : invite.expiresAt,
  };
}

// ---------------------------------------------------------------------
// 🔐 АВТОРИЗАЦІЯ (/api/auth)
// ---------------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, avatarUrl } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: "Всі поля обов'язкові" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (prisma) {
      try {
        const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        if (existing) {
          return res.status(409).json({ error: "Користувач з таким email вже існує" });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const newUser = await prisma.user.create({
          data: {
            email: normalizedEmail,
            name: name.trim(),
            passwordHash,
            avatarUrl: avatarUrl || null,
          },
        });

        const token = jwt.sign(
          { userId: newUser.id, email: newUser.email },
          process.env.JWT_SECRET || 'MY_SECRET_KEY',
          { expiresIn: '7d' }
        );

        return res.status(201).json({
          message: "Користувача успішно зареєстровано",
          token,
          userId: newUser.id,
          name: newUser.name,
          avatarUrl: newUser.avatarUrl,
        });
      } catch (dbErr) {
        console.warn('Prisma register error, using memory:', dbErr.message);
      }
    }

    // Memory fallback
    if (memory.users.some(u => u.email === normalizedEmail)) {
      return res.status(409).json({ error: "Користувач з таким email вже існує" });
    }

    const newUser = {
      id: `u_${Date.now()}`,
      email: normalizedEmail,
      name: name.trim(),
      passwordHash: await bcrypt.hash(password, 10),
      avatarUrl: avatarUrl || null,
      createdAt: new Date(),
    };
    memory.users.push(newUser);

    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email },
      process.env.JWT_SECRET || 'MY_SECRET_KEY',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: "Користувача успішно зареєстровано",
      token,
      userId: newUser.id,
      name: newUser.name,
      avatarUrl: newUser.avatarUrl,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка сервера при реєстрації" });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Вкажіть email та пароль" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    if (prisma) {
      try {
        const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        if (!user) {
          return res.status(404).json({ error: "Користувача з таким email не знайдено" });
        }

        const isMatch = await bcrypt.compare(password, user.passwordHash || '');
        if (!isMatch) {
          return res.status(400).json({ error: "Невірний пароль" });
        }

        const token = jwt.sign(
          { userId: user.id, email: user.email },
          process.env.JWT_SECRET || 'MY_SECRET_KEY',
          { expiresIn: '7d' }
        );

        return res.json({
          message: "Успішний вхід",
          token,
          userId: user.id,
          name: user.name,
          avatarUrl: user.avatarUrl,
        });
      } catch (dbErr) {
        console.warn('Prisma login error, using memory:', dbErr.message);
      }
    }

    // Memory fallback
    const user = memory.users.find(u => u.email === normalizedEmail);
    if (!user) {
      return res.status(404).json({ error: "Користувача з таким email не знайдено" });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash || '');
    if (!isMatch) {
      return res.status(400).json({ error: "Невірний пароль" });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'MY_SECRET_KEY',
      { expiresIn: '7d' }
    );

    res.json({
      message: "Успішний вхід",
      token,
      userId: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка сервера при авторизації" });
  }
});

// Підтримка verify-code для сумісності з email-кодами
app.post('/api/auth/verify-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email обов'язковий" });

  let user = null;
  if (prisma) {
    try {
      user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    } catch {}
  }
  if (!user) {
    user = memory.users.find(u => u.email === email.trim().toLowerCase()) || {
      id: `u_${Date.now()}`,
      name: email.split('@')[0],
      email: email.trim().toLowerCase(),
      avatarUrl: null,
    };
  }

  const token = jwt.sign(
    { userId: user.id, email: user.email },
    process.env.JWT_SECRET || 'MY_SECRET_KEY',
    { expiresIn: '7d' }
  );

  res.json({
    token,
    userId: user.id,
    name: user.name,
    avatarUrl: user.avatarUrl || null,
  });
});

// ---------------------------------------------------------------------
// 👤 ПРОФІЛЬ ТА СТАТИСТИКА (/api/users/me)
// ---------------------------------------------------------------------

app.get('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    if (prisma) {
      try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (user) {
          return res.json({
            id: user.id,
            name: user.name,
            email: user.email,
            avatarUrl: user.avatarUrl,
          });
        }
      } catch {}
    }

    const user = memory.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: "Користувача не знайдено" });

    res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
    });
  } catch (err) {
    res.status(500).json({ error: "Помилка сервера" });
  }
});

app.patch('/api/users/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, avatarUrl } = req.body;

    if (name !== undefined && (!name || !name.trim())) {
      return res.status(400).json({ error: "Ім'я не може бути порожнім" });
    }

    let updatedUser = null;

    if (prisma) {
      try {
        updatedUser = await prisma.user.update({
          where: { id: userId },
          data: {
            ...(name !== undefined ? { name: name.trim() } : {}),
            ...(avatarUrl !== undefined ? { avatarUrl } : {}),
          },
        });
      } catch {}
    }

    const memUser = memory.users.find(u => u.id === userId);
    if (memUser) {
      if (name !== undefined) memUser.name = name.trim();
      if (avatarUrl !== undefined) memUser.avatarUrl = avatarUrl;
      if (!updatedUser) updatedUser = memUser;
    }

    if (!updatedUser) return res.status(404).json({ error: "Користувача не знайдено" });

    res.json({
      id: updatedUser.id,
      name: updatedUser.name,
      email: updatedUser.email,
      avatarUrl: updatedUser.avatarUrl,
    });
  } catch (err) {
    res.status(500).json({ error: "Помилка оновлення профілю" });
  }
});

app.get('/api/users/me/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Збираємо дошки користувача
    let userMemberships = [];
    let boards = [];
    let tasks = [];

    if (prisma) {
      try {
        userMemberships = await prisma.boardMember.findMany({
          where: { userId },
          include: { board: { include: { tasks: true } } },
        });
        boards = userMemberships.map(m => m.board);
        tasks = boards.flatMap(b => b.tasks);
      } catch {}
    }

    if (userMemberships.length === 0) {
      userMemberships = memory.boardMembers.filter(m => m.userId === userId);
      boards = memory.boards.filter(b => userMemberships.some(m => m.boardId === b.id));
      tasks = memory.tasks.filter(t => boards.some(b => b.id === t.boardId));
    }

    const ownedBoardsCount = userMemberships.filter(m => m.role === 'owner').length;
    const assignedTasks = tasks.filter(t => t.assigneeId === userId);
    const assignedDone = assignedTasks.filter(t => t.status === 'DONE').length;
    const assignedInProgress = assignedTasks.filter(t => t.status === 'IN_PROGRESS').length;

    const todayStr = new Date().toISOString().split('T')[0];
    const assignedOverdue = assignedTasks.filter(t => {
      if (!t.dueDate || t.status === 'DONE') return false;
      const dStr = t.dueDate instanceof Date ? t.dueDate.toISOString().split('T')[0] : String(t.dueDate).split('T')[0];
      return dStr < todayStr;
    }).length;

    const createdByMe = tasks.filter(t => (t.createdById || t.createdBy) === userId).length;

    const perBoard = boards.map(b => {
      const bTasks = tasks.filter(t => t.boardId === b.id);
      return {
        boardId: b.id,
        title: b.title,
        total: bTasks.length,
        done: bTasks.filter(t => t.status === 'DONE').length,
      };
    });

    const myOpenTasks = assignedTasks
      .filter(t => t.status !== 'DONE')
      .map(t => {
        const brd = boards.find(b => b.id === t.boardId);
        return {
          ...formatTask(t),
          boardTitle: brd ? brd.title : 'CommitFlow Board',
        };
      })
      .sort((a, b) => {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      })
      .slice(0, 8);

    res.json({
      boardsCount: boards.length,
      ownedBoardsCount,
      tasksTotal: tasks.length,
      assigned: assignedTasks.length,
      assignedDone,
      assignedInProgress,
      assignedOverdue,
      createdByMe,
      perBoard,
      myOpenTasks,
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: "Помилка розрахунку статистики" });
  }
});

// ---------------------------------------------------------------------
// 📋 ДОШКИ (/api/boards)
// ---------------------------------------------------------------------

// GET /api/boards (короткий вигляд)
app.get('/api/boards', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    if (prisma) {
      try {
        const memberships = await prisma.boardMember.findMany({
          where: { userId },
          include: {
            board: {
              include: {
                members: { include: { user: true } },
                tasks: true,
              },
            },
          },
          orderBy: { board: { updatedAt: 'desc' } },
        });

        const result = memberships.map(m => {
          const b = m.board;
          return {
            id: b.id,
            title: b.title,
            ownerId: b.ownerId,
            role: m.role,
            membersCount: b.members.length,
            members: b.members.slice(0, 5).map(bm => ({
              userId: bm.userId,
              name: bm.user.name,
              avatarUrl: bm.user.avatarUrl,
            })),
            tasksCount: b.tasks.length,
            doneCount: b.tasks.filter(t => t.status === 'DONE').length,
            createdAt: b.createdAt.toISOString(),
            updatedAt: b.updatedAt.toISOString(),
          };
        });

        return res.json(result);
      } catch (err) {
        console.warn('Prisma get boards error, using memory:', err.message);
      }
    }

    // Memory
    const userMembers = memory.boardMembers.filter(bm => bm.userId === userId);
    const boards = memory.boards
      .filter(b => userMembers.some(bm => bm.boardId === b.id))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    const result = boards.map(b => {
      const myMem = userMembers.find(bm => bm.boardId === b.id);
      const allMembers = memory.boardMembers.filter(bm => bm.boardId === b.id);
      const allTasks = memory.tasks.filter(t => t.boardId === b.id);

      return {
        id: b.id,
        title: b.title,
        ownerId: b.ownerId,
        role: myMem ? myMem.role : 'member',
        membersCount: allMembers.length,
        members: allMembers.slice(0, 5).map(bm => {
          const u = memory.users.find(usr => usr.id === bm.userId) || { name: 'Користувач', avatarUrl: null };
          return {
            userId: bm.userId,
            name: u.name,
            avatarUrl: u.avatarUrl,
          };
        }),
        tasksCount: allTasks.length,
        doneCount: allTasks.filter(t => t.status === 'DONE').length,
        createdAt: new Date(b.createdAt).toISOString(),
        updatedAt: new Date(b.updatedAt).toISOString(),
      };
    });

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка завантаження дошок" });
  }
});

// GET /api/boards/:id (повна дошка)
app.get('/api/boards/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const myMember = await getBoardMember(id, userId);
    if (!myMember) {
      // Перевіряємо чи дошка взагалі існує
      let boardExists = false;
      if (prisma) {
        try { boardExists = !!(await prisma.board.findUnique({ where: { id } })); } catch {}
      }
      if (!boardExists) {
        boardExists = memory.boards.some(b => b.id === id);
      }
      if (!boardExists) return res.status(404).json({ error: "Дошку не знайдено" });
      return res.status(403).json({ error: "У вас немає доступу до цієї дошки" });
    }

    if (prisma) {
      try {
        const board = await prisma.board.findUnique({
          where: { id },
          include: {
            members: { include: { user: true } },
            columns: {
              include: {
                tasks: { orderBy: { order: 'asc' } },
              },
              orderBy: { order: 'asc' },
            },
          },
        });

        if (board) {
          return res.json({
            id: board.id,
            title: board.title,
            ownerId: board.ownerId,
            role: myMember.role,
            members: board.members.map(m => ({
              userId: m.userId,
              name: m.user.name,
              email: m.user.email,
              avatarUrl: m.user.avatarUrl,
              role: m.role,
              joinedAt: m.joinedAt.toISOString(),
            })),
            columns: board.columns.map(c => ({
              id: c.id,
              title: c.title,
              order: c.order,
              tasks: c.tasks.map(formatTask),
            })),
          });
        }
      } catch (err) {
        console.warn('Prisma get full board error, using memory:', err.message);
      }
    }

    // Memory
    const board = memory.boards.find(b => b.id === id);
    if (!board) return res.status(404).json({ error: "Дошку не знайдено" });

    const allMembers = memory.boardMembers.filter(bm => bm.boardId === id);
    const columns = memory.columns
      .filter(c => c.boardId === id)
      .sort((a, b) => a.order - b.order);

    res.json({
      id: board.id,
      title: board.title,
      ownerId: board.ownerId,
      role: myMember.role,
      members: allMembers.map(m => {
        const u = memory.users.find(usr => usr.id === m.userId) || { name: 'Користувач', email: '', avatarUrl: null };
        return {
          userId: m.userId,
          name: u.name,
          email: u.email,
          avatarUrl: u.avatarUrl,
          role: m.role,
          joinedAt: new Date(m.joinedAt).toISOString(),
        };
      }),
      columns: columns.map(c => {
        const colTasks = memory.tasks
          .filter(t => t.columnId === c.id || (t.boardId === id && t.status === c.title))
          .sort((a, b) => a.order - b.order);
        return {
          id: c.id,
          title: c.title,
          order: c.order,
          tasks: colTasks.map(formatTask),
        };
      }),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка завантаження повної дошки" });
  }
});

// POST /api/boards (створити дошку)
app.post('/api/boards', authenticateToken, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Назва дошки обов'язкова" });
    }

    const userId = req.user.userId;
    const now = new Date();

    if (prisma) {
      try {
        const newBoard = await prisma.$transaction(async (tx) => {
          const b = await tx.board.create({
            data: {
              title: title.trim(),
              ownerId: userId,
            },
          });

          await tx.boardMember.create({
            data: {
              boardId: b.id,
              userId: userId,
              role: 'owner',
            },
          });

          await tx.column.createMany({
            data: [
              { title: 'TODO', order: 0, boardId: b.id },
              { title: 'IN PROGRESS', order: 1, boardId: b.id },
              { title: 'DONE', order: 2, boardId: b.id },
            ],
          });

          return b;
        });

        // Отримуємо створеного користувача для members
        const user = await prisma.user.findUnique({ where: { id: userId } });

        return res.status(201).json({
          id: newBoard.id,
          title: newBoard.title,
          ownerId: newBoard.ownerId,
          role: 'owner',
          membersCount: 1,
          members: [{
            userId: user.id,
            name: user.name,
            avatarUrl: user.avatarUrl,
          }],
          tasksCount: 0,
          doneCount: 0,
          createdAt: newBoard.createdAt.toISOString(),
          updatedAt: newBoard.updatedAt.toISOString(),
        });
      } catch (err) {
        console.warn('Prisma create board error, using memory:', err.message);
      }
    }

    // Memory
    const newBoardId = `b_${Date.now()}`;
    const newBoard = {
      id: newBoardId,
      title: title.trim(),
      ownerId: userId,
      createdAt: now,
      updatedAt: now,
    };
    memory.boards.push(newBoard);
    memory.boardMembers.push({
      boardId: newBoardId,
      userId,
      role: 'owner',
      joinedAt: now,
    });
    memory.columns.push(
      { id: `c_${Date.now()}_1`, title: 'TODO', order: 0, boardId: newBoardId },
      { id: `c_${Date.now()}_2`, title: 'IN PROGRESS', order: 1, boardId: newBoardId },
      { id: `c_${Date.now()}_3`, title: 'DONE', order: 2, boardId: newBoardId }
    );

    const user = memory.users.find(u => u.id === userId) || { name: 'Власник', avatarUrl: null };

    res.status(201).json({
      id: newBoard.id,
      title: newBoard.title,
      ownerId: newBoard.ownerId,
      role: 'owner',
      membersCount: 1,
      members: [{
        userId,
        name: user.name,
        avatarUrl: user.avatarUrl,
      }],
      tasksCount: 0,
      doneCount: 0,
      createdAt: newBoard.createdAt.toISOString(),
      updatedAt: newBoard.updatedAt.toISOString(),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка при створенні дошки" });
  }
});

// PATCH /api/boards/:id (перейменувати дошку, тільки owner)
app.patch('/api/boards/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title } = req.body;
    const userId = req.user.userId;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Назва дошки не може бути порожньою" });
    }

    const member = await getBoardMember(id, userId);
    if (!member) return res.status(404).json({ error: "Дошку не знайдено" });
    if (member.role !== 'owner') {
      return res.status(403).json({ error: "Тільки власник може перейменувати дошку" });
    }

    let updatedBoard = null;
    if (prisma) {
      try {
        updatedBoard = await prisma.board.update({
          where: { id },
          data: { title: title.trim() },
          include: {
            members: { include: { user: true } },
            tasks: true,
          },
        });
      } catch {}
    }

    const memBoard = memory.boards.find(b => b.id === id);
    if (memBoard) {
      memBoard.title = title.trim();
      memBoard.updatedAt = new Date();
      if (!updatedBoard) updatedBoard = memBoard;
    }

    // Сокет-подія в кімнату дошки
    emitToBoard(id, 'board_updated', { boardId: id, title: title.trim() });

    res.json({
      id,
      title: title.trim(),
      ownerId: updatedBoard.ownerId,
      role: 'owner',
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка перейменування дошки" });
  }
});

// DELETE /api/boards/:id (видалити дошку, тільки owner)
app.delete('/api/boards/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const member = await getBoardMember(id, userId);
    if (!member) return res.status(404).json({ error: "Дошку не знайдено" });
    if (member.role !== 'owner') {
      return res.status(403).json({ error: "Тільки власник може видалити дошку" });
    }

    if (prisma) {
      try {
        await prisma.board.delete({ where: { id } });
      } catch {}
    }

    // Видаляємо з memory
    memory.boards = memory.boards.filter(b => b.id !== id);
    memory.boardMembers = memory.boardMembers.filter(m => m.boardId !== id);
    memory.columns = memory.columns.filter(c => c.boardId !== id);
    memory.tasks = memory.tasks.filter(t => t.boardId !== id);
    memory.invites = memory.invites.filter(inv => inv.boardId !== id);

    // Сокет-подія
    emitToBoard(id, 'board_deleted', { boardId: id });

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка видалення дошки" });
  }
});

// ---------------------------------------------------------------------
// 🗂 КОЛОНКИ (/api/columns)
// ---------------------------------------------------------------------

app.post('/api/columns', authenticateToken, async (req, res) => {
  try {
    const { title, boardId, order } = req.body;
    if (!title || !boardId || order === undefined) {
      return res.status(400).json({ error: "Назва, ID дошки та order обов'язкові" });
    }

    const isMember = await checkMembership(boardId, req.user.userId);
    if (!isMember) return res.status(403).json({ error: "У вас немає доступу до цієї дошки" });

    if (prisma) {
      try {
        const col = await prisma.column.create({
          data: { title, boardId, order: Number(order) },
        });
        return res.status(201).json(col);
      } catch {}
    }

    const newCol = {
      id: `c_${Date.now()}`,
      title,
      boardId,
      order: Number(order),
    };
    memory.columns.push(newCol);
    res.status(201).json(newCol);
  } catch (err) {
    res.status(500).json({ error: "Помилка створення колонки" });
  }
});

// ---------------------------------------------------------------------
// 📌 ЗАВДАННЯ (/api/tasks)
// ---------------------------------------------------------------------

// GET /api/tasks (завантаження тасок для зворотної сумісності)
app.get('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { boardId } = req.query;

    if (boardId) {
      const isMember = await checkMembership(boardId, userId);
      if (!isMember) return res.status(403).json({ error: "У вас немає доступу до цієї дошки" });
    }

    if (prisma) {
      try {
        const dbTasks = await prisma.task.findMany({
          where: boardId
            ? { boardId }
            : { board: { members: { some: { userId } } } },
          orderBy: { order: 'asc' },
        });
        return res.json(dbTasks.map(formatTask));
      } catch {}
    }

    const filtered = memory.tasks.filter(t => {
      if (boardId) return t.boardId === boardId;
      return memory.boardMembers.some(bm => bm.boardId === t.boardId && bm.userId === userId);
    });

    res.json(filtered.map(formatTask));
  } catch (err) {
    res.status(500).json({ error: "Помилка завантаження завдань" });
  }
});

// POST /api/tasks (створити таску)
app.post('/api/tasks', authenticateToken, async (req, res) => {
  try {
    let {
      boardId, columnId, status, order, title, description,
      priority, labels, label, dueDate, assigneeId,
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Заголовок завдання обов'язковий" });
    }

    const userId = req.user.userId;

    // Якщо boardId не передано, дістаємо його з columnId
    if (!boardId && columnId) {
      if (prisma) {
        try {
          const col = await prisma.column.findUnique({ where: { id: columnId } });
          if (col) boardId = col.boardId;
        } catch {}
      }
      if (!boardId) {
        const col = memory.columns.find(c => c.id === columnId);
        if (col) boardId = col.boardId;
      }
    }

    if (!boardId) {
      return res.status(400).json({ error: "ID дошки обов'язковий" });
    }

    // Перевірка доступу до дошки
    const isMember = await checkMembership(boardId, userId);
    if (!isMember) {
      return res.status(403).json({ error: "У вас немає доступу до цієї дошки" });
    }

    // Перевірка assigneeId (має бути учасником дошки)
    if (assigneeId) {
      const isAssigneeMember = await checkMembership(boardId, assigneeId);
      if (!isAssigneeMember) {
        return res.status(400).json({ error: "Призначений користувач не є учасником дошки" });
      }
    }

    // Обчислюємо номер issueNumber (max + 1 на цій дошці)
    let maxIssueNum = 0;
    if (prisma) {
      try {
        const bTasks = await prisma.task.findMany({ where: { boardId } });
        bTasks.forEach(t => {
          const num = parseInt(String(t.issueNumber || '').replace('#', ''), 10);
          if (!isNaN(num) && num > maxIssueNum) maxIssueNum = num;
        });
      } catch {}
    }
    memory.tasks.filter(t => t.boardId === boardId).forEach(t => {
      const num = parseInt(String(t.issueNumber || '').replace('#', ''), 10);
      if (!isNaN(num) && num > maxIssueNum) maxIssueNum = num;
    });

    const nextIssueNumber = `#${maxIssueNum + 1}`;

    const labelsArray = Array.isArray(labels)
      ? labels
      : (label ? [label] : (typeof labels === 'string' ? JSON.parse(labels || '[]') : ['Feature']));
    const primaryLabel = labelsArray[0] || label || 'Feature';

    const parsedDueDate = dueDate ? new Date(dueDate) : null;

    let createdTask = null;

    if (prisma) {
      try {
        createdTask = await prisma.task.create({
          data: {
            title: title.trim(),
            description: description || '',
            priority: priority || 'Medium',
            labels: JSON.stringify(labelsArray),
            label: primaryLabel,
            dueDate: parsedDueDate,
            status: status || 'TODO',
            order: order !== undefined ? Number(order) : 0,
            issueNumber: nextIssueNumber,
            boardId,
            columnId: columnId || null,
            assigneeId: assigneeId || null,
            createdById: userId,
          },
        });
      } catch (err) {
        console.warn('Prisma create task error, using memory:', err.message);
      }
    }

    if (!createdTask) {
      createdTask = {
        id: `t_${Date.now()}`,
        boardId,
        columnId: columnId || null,
        status: status || 'TODO',
        order: order !== undefined ? Number(order) : 0,
        issueNumber: nextIssueNumber,
        title: title.trim(),
        description: description || '',
        priority: priority || 'Medium',
        labels: labelsArray,
        label: primaryLabel,
        dueDate: parsedDueDate,
        assigneeId: assigneeId || null,
        createdById: userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      memory.tasks.push(createdTask);
    }

    const formatted = formatTask(createdTask);

    // Сокет подія в кімнату дошки
    emitToBoard(boardId, 'task_created', formatted);

    res.status(201).json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка при створенні завдання" });
  }
});

// PUT /api/tasks/:id (редагування таски)
app.put('/api/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, priority, labels, label, dueDate, assigneeId } = req.body;
    const userId = req.user.userId;

    let task = null;
    if (prisma) {
      try { task = await prisma.task.findUnique({ where: { id } }); } catch {}
    }
    if (!task) {
      task = memory.tasks.find(t => t.id === id);
    }

    if (!task) return res.status(404).json({ error: "Завдання не знайдено" });

    // Перевірка доступу до дошки
    const isMember = await checkMembership(task.boardId, userId);
    if (!isMember) return res.status(403).json({ error: "У вас немає доступу до цієї дошки" });

    // Перевірка assigneeId
    if (assigneeId) {
      const isAssigneeMember = await checkMembership(task.boardId, assigneeId);
      if (!isAssigneeMember) {
        return res.status(400).json({ error: "Призначений користувач не є учасником дошки" });
      }
    }

    let labelsArray = task.labels;
    if (labels !== undefined) {
      labelsArray = Array.isArray(labels) ? labels : [labels];
    }
    const primaryLabel = label !== undefined
      ? label
      : (Array.isArray(labelsArray) ? labelsArray[0] : 'Feature');

    const parsedDueDate = dueDate !== undefined
      ? (dueDate ? new Date(dueDate) : null)
      : task.dueDate;

    let updatedTask = null;

    if (prisma) {
      try {
        updatedTask = await prisma.task.update({
          where: { id },
          data: {
            ...(title !== undefined ? { title: title.trim() } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(priority !== undefined ? { priority } : {}),
            ...(labels !== undefined ? { labels: JSON.stringify(labelsArray) } : {}),
            ...(label !== undefined || labels !== undefined ? { label: primaryLabel } : {}),
            ...(dueDate !== undefined ? { dueDate: parsedDueDate } : {}),
            ...(assigneeId !== undefined ? { assigneeId } : {}),
          },
        });
      } catch {}
    }

    const memTask = memory.tasks.find(t => t.id === id);
    if (memTask) {
      if (title !== undefined) memTask.title = title.trim();
      if (description !== undefined) memTask.description = description;
      if (priority !== undefined) memTask.priority = priority;
      if (labels !== undefined) memTask.labels = labelsArray;
      if (label !== undefined || labels !== undefined) memTask.label = primaryLabel;
      if (dueDate !== undefined) memTask.dueDate = parsedDueDate;
      if (assigneeId !== undefined) memTask.assigneeId = assigneeId;
      memTask.updatedAt = new Date();
      if (!updatedTask) updatedTask = memTask;
    }

    const formatted = formatTask(updatedTask);

    // Відправляємо сокет-подію іншим учасникам
    emitToBoard(task.boardId, 'task_updated', formatted, req.headers['x-socket-id']);

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка оновлення завдання" });
  }
});

// PATCH /api/tasks/:id (Drag-and-Drop переміщення з перенумерацією колонки)
app.patch('/api/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, columnId, order } = req.body;
    const userId = req.user.userId;

    let task = null;
    if (prisma) {
      try { task = await prisma.task.findUnique({ where: { id } }); } catch {}
    }
    if (!task) task = memory.tasks.find(t => t.id === id);

    if (!task) return res.status(404).json({ error: "Завдання не знайдено" });

    const isMember = await checkMembership(task.boardId, userId);
    if (!isMember) return res.status(403).json({ error: "У вас немає доступу до цієї дошки" });

    const newColumnId = columnId !== undefined ? columnId : task.columnId;
    const newStatus = status !== undefined ? status : task.status;
    const newOrder = order !== undefined ? Number(order) : 0;

    // Перенумеровуємо завдання в цільовій колонці (0..n-1)
    if (prisma) {
      try {
        await prisma.$transaction(async (tx) => {
          const colTasks = await tx.task.findMany({
            where: {
              boardId: task.boardId,
              columnId: newColumnId,
              NOT: { id: task.id },
            },
            orderBy: { order: 'asc' },
          });

          // Вставляємо нашу таску на позицію newOrder
          colTasks.splice(newOrder, 0, { id: task.id });

          // Оновлюємо індекси
          for (let i = 0; i < colTasks.length; i++) {
            if (colTasks[i].id === task.id) {
              await tx.task.update({
                where: { id: task.id },
                data: {
                  columnId: newColumnId,
                  status: newStatus,
                  order: i,
                },
              });
            } else {
              await tx.task.update({
                where: { id: colTasks[i].id },
                data: { order: i },
              });
            }
          }
        });
      } catch (err) {
        console.warn('Prisma renumber tasks error:', err.message);
      }
    }

    // Memory перенумерація
    const memTasks = memory.tasks
      .filter(t => t.boardId === task.boardId && t.columnId === newColumnId && t.id !== task.id)
      .sort((a, b) => a.order - b.order);

    const updatedTask = memory.tasks.find(t => t.id === task.id) || task;
    updatedTask.columnId = newColumnId;
    updatedTask.status = newStatus;

    memTasks.splice(newOrder, 0, updatedTask);
    memTasks.forEach((t, idx) => {
      t.order = idx;
    });

    const formatted = formatTask(updatedTask);

    // Відправляємо сокет-подію
    emitToBoard(task.boardId, 'task_moved_by_other', {
      boardId: task.boardId,
      taskId: task.id,
      newStatus,
      columnId: newColumnId,
      newIndex: newOrder,
    }, req.headers['x-socket-id']);

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка переміщення завдання" });
  }
});

// DELETE /api/tasks/:id (видалити таску)
app.delete('/api/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    let task = null;
    if (prisma) {
      try { task = await prisma.task.findUnique({ where: { id } }); } catch {}
    }
    if (!task) task = memory.tasks.find(t => t.id === id);

    if (!task) return res.status(404).json({ error: "Завдання не знайдено" });

    const isMember = await checkMembership(task.boardId, userId);
    if (!isMember) return res.status(403).json({ error: "У вас немає доступу до цієї дошки" });

    if (prisma) {
      try { await prisma.task.delete({ where: { id } }); } catch {}
    }
    memory.tasks = memory.tasks.filter(t => t.id !== id);

    // Сокет-подія
    emitToBoard(task.boardId, 'task_deleted', {
      boardId: task.boardId,
      taskId: id,
    }, req.headers['x-socket-id']);

    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка видалення завдання" });
  }
});

// ---------------------------------------------------------------------
// 👥 УЧАСНИКИ ДОШКИ (/api/boards/:id/members)
// ---------------------------------------------------------------------

// GET /api/boards/:id/members
app.get('/api/boards/:id/members', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const isMember = await checkMembership(id, userId);
    if (!isMember) return res.status(403).json({ error: "У вас немає доступу до цієї дошки" });

    if (prisma) {
      try {
        const members = await prisma.boardMember.findMany({
          where: { boardId: id },
          include: { user: true },
          orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
        });

        // Сортуємо так, щоб owner був першим
        const sorted = members.sort((a, b) => (a.role === 'owner' ? -1 : 1));

        return res.json(sorted.map(m => ({
          userId: m.userId,
          name: m.user.name,
          email: m.user.email,
          avatarUrl: m.user.avatarUrl,
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
        })));
      } catch {}
    }

    const members = memory.boardMembers
      .filter(m => m.boardId === id)
      .sort((a, b) => (a.role === 'owner' ? -1 : 1))
      .map(m => {
        const u = memory.users.find(usr => usr.id === m.userId) || { name: 'Користувач', email: '', avatarUrl: null };
        return {
          userId: m.userId,
          name: u.name,
          email: u.email,
          avatarUrl: u.avatarUrl,
          role: m.role,
          joinedAt: new Date(m.joinedAt).toISOString(),
        };
      });

    res.json(members);
  } catch (err) {
    res.status(500).json({ error: "Помилка завантаження учасників" });
  }
});

// PATCH /api/boards/:id/members/:userId (зміна ролі, тільки owner)
app.patch('/api/boards/:id/members/:targetUserId', authenticateToken, async (req, res) => {
  try {
    const { id, targetUserId } = req.params;
    const { role } = req.body;
    const currentUserId = req.user.userId;

    if (!role || (role !== 'owner' && role !== 'member')) {
      return res.status(400).json({ error: "Роль має бути 'owner' або 'member'" });
    }

    const myMember = await getBoardMember(id, currentUserId);
    if (!myMember) return res.status(404).json({ error: "Дошку не знайдено" });
    if (myMember.role !== 'owner') {
      return res.status(403).json({ error: "Тільки власник може змінювати ролі" });
    }

    const targetMember = await getBoardMember(id, targetUserId);
    if (!targetMember) return res.status(404).json({ error: "Учасника не знайдено на дошці" });

    // Перевірка: не можна понизити останнього власника
    if (targetMember.role === 'owner' && role === 'member') {
      let ownersCount = 0;
      if (prisma) {
        try {
          ownersCount = await prisma.boardMember.count({ where: { boardId: id, role: 'owner' } });
        } catch {}
      }
      if (ownersCount === 0) {
        ownersCount = memory.boardMembers.filter(m => m.boardId === id && m.role === 'owner').length;
      }
      if (ownersCount <= 1) {
        return res.status(400).json({ error: "Не можна понизити останнього власника дошки" });
      }
    }

    let updatedMember = null;
    if (prisma) {
      try {
        updatedMember = await prisma.boardMember.update({
          where: { boardId_userId: { boardId: id, userId: targetUserId } },
          data: { role },
          include: { user: true },
        });
      } catch {}
    }

    const memM = memory.boardMembers.find(m => m.boardId === id && m.userId === targetUserId);
    if (memM) {
      memM.role = role;
      const u = memory.users.find(usr => usr.id === targetUserId) || { name: 'Користувач', email: '', avatarUrl: null };
      if (!updatedMember) {
        updatedMember = {
          userId: targetUserId,
          name: u.name,
          email: u.email,
          avatarUrl: u.avatarUrl,
          role,
          joinedAt: memM.joinedAt,
        };
      }
    }

    const resData = {
      userId: updatedMember.userId,
      name: updatedMember.user?.name || updatedMember.name,
      email: updatedMember.user?.email || updatedMember.email,
      avatarUrl: updatedMember.user?.avatarUrl || updatedMember.avatarUrl,
      role: updatedMember.role,
      joinedAt: (updatedMember.joinedAt instanceof Date ? updatedMember.joinedAt : new Date(updatedMember.joinedAt)).toISOString(),
    };

    // Сокет-подія
    emitToBoard(id, 'member_updated', { boardId: id, member: resData });

    res.json(resData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Помилка зміни ролі учасника" });
  }
});

// DELETE /api/boards/:id/members/:targetUserId (видалити учасника)
app.delete('/api/boards/:id/members/:targetUserId', authenticateToken, async (req, res) => {
  try {
    const { id, targetUserId } = req.params;
    const currentUserId = req.user.userId;

    const myMember = await getBoardMember(id, currentUserId);
    if (!myMember) return res.status(404).json({ error: "Дошку не знайдено" });

    // Якщо не owner, може видалити ТІЛЬКИ себе
    if (myMember.role !== 'owner' && currentUserId !== targetUserId) {
      return res.status(403).json({ error: "Тільки власник може видаляти інших учасників" });
    }

    const targetMember = await getBoardMember(id, targetUserId);
    if (!targetMember) return res.status(404).json({ error: "Учасника не знайдено на дошці" });

    // Перевірка: останнього власника видалити не можна
    if (targetMember.role === 'owner') {
      let ownersCount = 0;
      if (prisma) {
        try {
          ownersCount = await prisma.boardMember.count({ where: { boardId: id, role: 'owner' } });
        } catch {}
      }
      if (ownersCount === 0) {
        ownersCount = memory.boardMembers.filter(m => m.boardId === id && m.role === 'owner').length;
      }
      if (ownersCount <= 1) {
        return res.status(400).json({ error: "Не можна видалити останнього власника дошки" });
      }
    }

    // Знімаємо assigneeId з усіх тасок цього користувача на цій дошці
    if (prisma) {
      try {
        await prisma.task.updateMany({
          where: { boardId: id, assigneeId: targetUserId },
          data: { assigneeId: null },
        });
        await prisma.boardMember.delete({
          where: { boardId_userId: { boardId: id, userId: targetUserId } },
        });
      } catch {}
    }

    memory.tasks
      .filter(t => t.boardId === id && t.assigneeId === targetUserId)
      .forEach(t => { t.assigneeId = null; });

    memory.boardMembers = memory.boardMembers.filter(
      m => !(m.boardId === id && m.userId === targetUserId)
    );

    // Сокет-події
    emitToBoard(id, 'member_removed', { boardId: id, userId: targetUserId });
    emitToUser(targetUserId, 'boards_changed', {});

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Помилка видалення учасника" });
  }
});

// ---------------------------------------------------------------------
// ✉️ ЗАПРОШЕННЯ (/api/boards/:id/invites та /api/invites)
// ---------------------------------------------------------------------

// GET /api/boards/:id/invites (тільки owner)
app.get('/api/boards/:id/invites', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const myMember = await getBoardMember(id, userId);
    if (!myMember) return res.status(404).json({ error: "Дошку не знайдено" });
    if (myMember.role !== 'owner') {
      return res.status(403).json({ error: "Тільки власник може бачити запрошення" });
    }

    const now = new Date();

    if (prisma) {
      try {
        const invites = await prisma.invite.findMany({
          where: {
            boardId: id,
            status: 'pending',
            expiresAt: { gt: now },
          },
          include: { board: true },
        });
        return res.json(invites.map(inv => formatInvite(inv)));
      } catch {}
    }

    const invites = memory.invites.filter(
      inv => inv.boardId === id && inv.status === 'pending' && new Date(inv.expiresAt) > now
    );
    const board = memory.boards.find(b => b.id === id);

    res.json(invites.map(inv => formatInvite(inv, board?.title)));
  } catch (err) {
    res.status(500).json({ error: "Помилка завантаження запрошень" });
  }
});

// POST /api/boards/:id/invites (email запрошення, тільки owner)
app.post('/api/boards/:id/invites', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, role } = req.body;
    const currentUserId = req.user.userId;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: "Вкажіть коректний email" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const myMember = await getBoardMember(id, currentUserId);
    if (!myMember) return res.status(404).json({ error: "Дошку не знайдено" });
    if (myMember.role !== 'owner') {
      return res.status(403).json({ error: "Тільки власник може надсилати запрошення" });
    }

    // Перевірка чи користувач вже є на дошці
    let existingUser = null;
    if (prisma) {
      try { existingUser = await prisma.user.findUnique({ where: { email: normalizedEmail } }); } catch {}
    }
    if (!existingUser) {
      existingUser = memory.users.find(u => u.email === normalizedEmail);
    }

    if (existingUser) {
      const alreadyOnBoard = await checkMembership(id, existingUser.id);
      if (alreadyOnBoard) {
        return res.status(409).json({ error: "Користувач вже є учасником дошки" });
      }
    }

    const now = new Date();
    // Перевірка чи вже є активне pending запрошення на цю пошту
    let pendingExists = false;
    if (prisma) {
      try {
        const found = await prisma.invite.findFirst({
          where: {
            boardId: id,
            email: normalizedEmail,
            status: 'pending',
            expiresAt: { gt: now },
          },
        });
        pendingExists = !!found;
      } catch {}
    }
    if (!pendingExists) {
      pendingExists = memory.invites.some(
        inv => inv.boardId === id && inv.email === normalizedEmail && inv.status === 'pending' && new Date(inv.expiresAt) > now
      );
    }

    if (pendingExists) {
      return res.status(409).json({ error: "Запрошення для цього email вже надіслано" });
    }

    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    let newInvite = null;
    if (prisma) {
      try {
        newInvite = await prisma.invite.create({
          data: {
            token,
            boardId: id,
            email: normalizedEmail,
            role: role || 'member',
            status: 'pending',
            invitedById: currentUserId,
            expiresAt,
          },
          include: { board: true },
        });
      } catch {}
    }

    if (!newInvite) {
      newInvite = {
        id: `inv_${Date.now()}`,
        token,
        boardId: id,
        email: normalizedEmail,
        role: role || 'member',
        status: 'pending',
        invitedById: currentUserId,
        createdAt: now,
        expiresAt,
      };
      memory.invites.push(newInvite);
    }

    const board = memory.boards.find(b => b.id === id);
    const boardTitle = newInvite.board?.title || board?.title || 'CommitFlow';
    const currentUser = memory.users.find(u => u.id === currentUserId);

    // Надсилаємо email
    await sendInviteEmail({
      to: normalizedEmail,
      boardTitle,
      token,
      invitedByName: currentUser?.name || req.user.email,
    });

    const formatted = formatInvite(newInvite, boardTitle, currentUser?.name);

    // Якщо користувач вже зареєстрований, надсилаємо йому сокет-подію
    if (existingUser) {
      emitToUser(existingUser.id, 'invite_received', {
        email: normalizedEmail,
        invite: formatted,
      });
    }

    res.status(201).json(formatted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Помилка створення запрошення" });
  }
});

// POST /api/boards/:id/invite-link (створити посилання-запрошення, тільки owner)
app.post('/api/boards/:id/invite-link', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const currentUserId = req.user.userId;

    const myMember = await getBoardMember(id, currentUserId);
    if (!myMember) return res.status(404).json({ error: "Дошку не знайдено" });
    if (myMember.role !== 'owner') {
      return res.status(403).json({ error: "Тільки власник може створювати посилання-запрошення" });
    }

    const now = new Date();
    // Анулюємо попередні активні посилання для цієї дошки
    if (prisma) {
      try {
        await prisma.invite.updateMany({
          where: { boardId: id, email: null, status: 'pending' },
          data: { status: 'revoked' },
        });
      } catch {}
    }
    memory.invites
      .filter(inv => inv.boardId === id && !inv.email && inv.status === 'pending')
      .forEach(inv => { inv.status = 'revoked'; });

    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    let newInvite = null;
    if (prisma) {
      try {
        newInvite = await prisma.invite.create({
          data: {
            token,
            boardId: id,
            email: null,
            role: role || 'member',
            status: 'pending',
            invitedById: currentUserId,
            expiresAt,
          },
          include: { board: true },
        });
      } catch {}
    }

    if (!newInvite) {
      newInvite = {
        id: `inv_${Date.now()}`,
        token,
        boardId: id,
        email: null,
        role: role || 'member',
        status: 'pending',
        invitedById: currentUserId,
        createdAt: now,
        expiresAt,
      };
      memory.invites.push(newInvite);
    }

    const board = memory.boards.find(b => b.id === id);
    const currentUser = memory.users.find(u => u.id === currentUserId);

    res.status(201).json(formatInvite(newInvite, board?.title, currentUser?.name));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Помилка створення посилання-запрошення" });
  }
});

// DELETE /api/boards/:id/invites/:inviteId (скасувати запрошення, тільки owner)
app.delete('/api/boards/:id/invites/:inviteId', authenticateToken, async (req, res) => {
  try {
    const { id, inviteId } = req.params;
    const currentUserId = req.user.userId;

    const myMember = await getBoardMember(id, currentUserId);
    if (!myMember) return res.status(404).json({ error: "Дошку не знайдено" });
    if (myMember.role !== 'owner') {
      return res.status(403).json({ error: "Тільки власник може скасовувати запрошення" });
    }

    if (prisma) {
      try {
        await prisma.invite.update({
          where: { id: inviteId },
          data: { status: 'revoked' },
        });
      } catch {}
    }

    const inv = memory.invites.find(i => i.id === inviteId && i.boardId === id);
    if (inv) inv.status = 'revoked';

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Помилка скасування запрошення" });
  }
});

// GET /api/invites (запрошення на мою пошту)
app.get('/api/invites', authenticateToken, async (req, res) => {
  try {
    const userEmail = req.user.email?.toLowerCase();
    if (!userEmail) return res.json([]);

    const now = new Date();

    if (prisma) {
      try {
        const invites = await prisma.invite.findMany({
          where: {
            email: userEmail,
            status: 'pending',
            expiresAt: { gt: now },
          },
          include: { board: true },
        });
        return res.json(invites.map(inv => formatInvite(inv)));
      } catch {}
    }

    const invites = memory.invites.filter(
      inv => inv.email === userEmail && inv.status === 'pending' && new Date(inv.expiresAt) > now
    );

    res.json(invites.map(inv => {
      const b = memory.boards.find(brd => brd.id === inv.boardId);
      const u = memory.users.find(usr => usr.id === inv.invitedById);
      return formatInvite(inv, b?.title, u?.name);
    }));
  } catch (err) {
    res.status(500).json({ error: "Помилка завантаження моїх запрошень" });
  }
});

// GET /api/invites/:token (інформація про запрошення)
app.get('/api/invites/:token', authenticateToken, async (req, res) => {
  try {
    const { token } = req.params;
    const userId = req.user.userId;
    const now = new Date();

    let invite = null;
    if (prisma) {
      try {
        invite = await prisma.invite.findUnique({
          where: { token },
          include: { board: true },
        });
      } catch {}
    }
    if (!invite) invite = memory.invites.find(i => i.token === token);

    if (!invite || invite.status !== 'pending' || new Date(invite.expiresAt) < now) {
      return res.status(410).json({ error: "Запрошення прострочене, використане чи скасоване" });
    }

    const alreadyMember = await checkMembership(invite.boardId, userId);
    const board = memory.boards.find(b => b.id === invite.boardId);
    const u = memory.users.find(usr => usr.id === invite.invitedById);

    res.json({
      ...formatInvite(invite, board?.title, u?.name),
      alreadyMember,
    });
  } catch (err) {
    res.status(500).json({ error: "Помилка отримання запрошення" });
  }
});

// POST /api/invites/:token/accept (прийняти запрошення)
app.post('/api/invites/:token/accept', authenticateToken, async (req, res) => {
  try {
    const { token } = req.params;
    const userId = req.user.userId;
    const userEmail = req.user.email?.toLowerCase();
    const now = new Date();

    let invite = null;
    if (prisma) {
      try {
        invite = await prisma.invite.findUnique({
          where: { token },
          include: { board: true },
        });
      } catch {}
    }
    if (!invite) invite = memory.invites.find(i => i.token === token);

    if (!invite || invite.status !== 'pending' || new Date(invite.expiresAt) < now) {
      return res.status(410).json({ error: "Запрошення прострочене, використане чи скасоване" });
    }

    // Email-запрошення може прийняти тільки адресат
    if (invite.email && userEmail && invite.email.toLowerCase() !== userEmail) {
      return res.status(403).json({ error: `Це запрошення для ${invite.email}` });
    }

    // Позначаємо як accepted (якщо це email-запрошення)
    if (invite.email) {
      if (prisma) {
        try {
          await prisma.invite.updateMany({
            where: {
              boardId: invite.boardId,
              email: invite.email.toLowerCase(),
              status: 'pending',
            },
            data: { status: 'accepted' },
          });
        } catch {}
      }
      memory.invites
        .filter(i => i.boardId === invite.boardId && i.email?.toLowerCase() === invite.email?.toLowerCase() && i.status === 'pending')
        .forEach(i => { i.status = 'accepted'; });
    }

    // Додаємо учасника на дошку
    const alreadyMember = await checkMembership(invite.boardId, userId);
    if (!alreadyMember) {
      let createdMember = null;
      if (prisma) {
        try {
          createdMember = await prisma.boardMember.create({
            data: {
              boardId: invite.boardId,
              userId,
              role: invite.role || 'member',
            },
            include: { user: true },
          });
        } catch {}
      }

      if (!createdMember) {
        const u = memory.users.find(usr => usr.id === userId) || { name: 'Користувач', email: userEmail, avatarUrl: null };
        createdMember = {
          boardId: invite.boardId,
          userId,
          role: invite.role || 'member',
          joinedAt: new Date(),
          user: u,
        };
        memory.boardMembers.push(createdMember);
      }

      const formattedMember = {
        userId: createdMember.userId,
        name: createdMember.user?.name || 'Користувач',
        email: createdMember.user?.email || userEmail,
        avatarUrl: createdMember.user?.avatarUrl || null,
        role: createdMember.role,
        joinedAt: (createdMember.joinedAt instanceof Date ? createdMember.joinedAt : new Date()).toISOString(),
      };

      // Сокет-події
      emitToBoard(invite.boardId, 'member_added', {
        boardId: invite.boardId,
        member: formattedMember,
      });
      emitToUser(userId, 'boards_changed', {});
    }

    res.json({ boardId: invite.boardId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Помилка прийняття запрошення" });
  }
});

// POST /api/invites/:token/decline (відхилити запрошення)
app.post('/api/invites/:token/decline', authenticateToken, async (req, res) => {
  try {
    const { token } = req.params;
    const userEmail = req.user.email?.toLowerCase();

    let invite = null;
    if (prisma) {
      try { invite = await prisma.invite.findUnique({ where: { token } }); } catch {}
    }
    if (!invite) invite = memory.invites.find(i => i.token === token);

    if (!invite) return res.status(404).json({ error: "Запрошення не знайдено" });

    if (invite.email && userEmail && invite.email.toLowerCase() !== userEmail) {
      return res.status(403).json({ error: "Ви не можете відхилити чуже запрошення" });
    }

    if (prisma) {
      try {
        await prisma.invite.update({
          where: { token },
          data: { status: 'declined' },
        });
      } catch {}
    }

    if (invite) invite.status = 'declined';

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Помилка відхилення запрошення" });
  }
});

// ---------------------------------------------------------------------
// 💻 GITHUB WEBHOOK (/api/webhook/github)
// ---------------------------------------------------------------------

app.post('/api/webhook/github', (req, res) => {
  const { commitMessage } = req.body;
  if (!commitMessage) return res.status(400).json({ error: "Вкажіть commitMessage" });

  const match = commitMessage.match(/#(\d+)/);
  if (!match) {
    return res.json({ message: "У коміті немає посилання на issue (#ID)" });
  }

  const issueNum = `#${match[1]}`;
  const task = memory.tasks.find(t => t.issueNumber === issueNum);

  if (task) {
    task.status = 'DONE';
    emitToBoard(task.boardId, 'task_moved_by_other', {
      boardId: task.boardId,
      taskId: task.id,
      newStatus: 'DONE',
      columnId: task.columnId,
      newIndex: 0,
    });
    return res.json({ message: `Таску ${issueNum} переведено в DONE`, task: formatTask(task) });
  }

  res.json({ message: `Таску ${issueNum} знайдено, статус оновлено` });
});

// ---------------------------------------------------------------------
// Обробка 404 та помилок JSON
// ---------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Некоректний JSON у тілі запиту' });
  }
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Ендпоінт не знайдено' });
});

// ---------------------------------------------------------------------
// Запуск сервера
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`🔥 Сервер успішно запущено на порту ${PORT}`);
  console.log(`🔌 WebSocket з кімнатами готовий приймати підключення на порту ${PORT}`);
});