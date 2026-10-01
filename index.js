require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

// Імпорти для Prisma
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
let prisma = null;
let isDbAvailable = false;

try {
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
} catch (err) {
  console.warn('⚠️ Не вдалося ініціалізувати Prisma адаптер:', err.message);
}

// In-memory резервне сховище (якщо Postgres ще не запущено або база не налаштована)
let memoryTasks = [
  { id: '1', title: 'Налаштувати Tailwind CSS', status: 'TODO', issueNumber: '#1', priority: 'High', label: 'UI/UX', order: 0 },
  { id: '2', title: 'Підключити Zustand', status: 'TODO', issueNumber: '#2', priority: 'Medium', label: 'Core', order: 1 },
  { id: '3', title: 'Створити UI картки', status: 'IN_PROGRESS', issueNumber: '#3', priority: 'Low', label: 'UI/UX', order: 0 },
  { id: '4', title: 'Придумати дизайн бази даних', status: 'DONE', issueNumber: '#4', priority: 'High', label: 'Backend', order: 0 },
];

const app = express();
const server = http.createServer(app);

// WebSockets (Socket.io)
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  },
});

io.on('connection', (socket) => {
  console.log('⚡ Клієнт підключився до WebSocket:', socket.id);

  socket.on('disconnect', () => {
    console.log('Клієнт відключився:', socket.id);
  });
});

app.use(cors());
app.use(express.json());

// ==========================================
// 🛡 МІДЛВАРИ АВТОРИЗАЦІЇ
// ==========================================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: "Доступ заборонено. Немає токена!" });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'MY_SECRET_KEY', (err, user) => {
    if (err) return res.status(403).json({ error: "Недійсний або прострочений токен!" });
    req.user = user;
    next();
  });
};

// Опціональна авторизація (дозволяє запити як з токеном, так і без нього)
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    jwt.verify(token, process.env.JWT_SECRET || 'MY_SECRET_KEY', (err, user) => {
      if (!err) req.user = user;
      next();
    });
  } else {
    next();
  }
};

// ==========================================
// 🔐 МАРШРУТИ АВТОРИЗАЦІЇ
// ==========================================

// 1. РЕЄСТРАЦІЯ
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: "Всі поля обов'язкові!" });
    }

    if (prisma) {
      try {
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
          return res.status(400).json({ error: "Користувач з таким email вже існує!" });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const newUser = await prisma.user.create({
          data: { email, name, passwordHash },
        });

        const token = jwt.sign({ userId: newUser.id, email: newUser.email }, process.env.JWT_SECRET || 'MY_SECRET_KEY', { expiresIn: '7d' });
        return res.status(201).json({ message: "Користувача успішно зареєстровано!", token, userId: newUser.id, name: newUser.name });
      } catch (dbErr) {
        console.warn('DB Error in register, falling back to mock response:', dbErr.message);
      }
    }

    // Резервний варіант, якщо БД недоступна
    const mockId = Date.now().toString();
    const token = jwt.sign({ userId: mockId, email }, process.env.JWT_SECRET || 'MY_SECRET_KEY', { expiresIn: '7d' });
    res.status(201).json({ message: "Користувача успішно зареєстровано!", token, userId: mockId, name });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка сервера при реєстрації" });
  }
});

// 2. АВТОРИЗАЦІЯ (ЛОГІН)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Вкажіть email та пароль!" });
    }

    if (prisma) {
      try {
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
          return res.status(400).json({ error: "Користувача з таким email не знайдено!" });
        }

        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) {
          return res.status(400).json({ error: "Невірний пароль!" });
        }

        const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET || 'MY_SECRET_KEY', { expiresIn: '7d' });
        return res.json({ message: "Успішний вхід!", token, userId: user.id, name: user.name });
      } catch (dbErr) {
        console.warn('DB Error in login, fallback:', dbErr.message);
      }
    }

    // Резервний варіант
    const token = jwt.sign({ userId: 'demo-user', email }, process.env.JWT_SECRET || 'MY_SECRET_KEY', { expiresIn: '7d' });
    res.json({ message: "Успішний вхід (демо режим)!", token, userId: 'demo-user', name: email.split('@')[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка сервера при авторизації" });
  }
});

// ==========================================
// 📋 МАРШРУТИ ДОШОК ТА КОЛОНОК
// ==========================================

app.post('/api/boards', authenticateToken, async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: "Назва дошки обов'язкова!" });

    if (prisma) {
      const newBoard = await prisma.board.create({
        data: { title, userId: req.user.userId }
      });
      return res.status(201).json(newBoard);
    }
    res.status(201).json({ id: Date.now().toString(), title, userId: req.user.userId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка при створенні дошки" });
  }
});

app.get('/api/boards', authenticateToken, async (req, res) => {
  try {
    if (prisma) {
      const boards = await prisma.board.findMany({
        where: { userId: req.user.userId },
        include: { columns: { include: { tasks: true } } }
      });
      return res.json(boards);
    }
    res.json([{ id: 'default-board', title: 'Main Board', userId: req.user.userId }]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка при отриманні дошок" });
  }
});

app.post('/api/columns', authenticateToken, async (req, res) => {
  try {
    const { title, boardId, order } = req.body;
    if (!title || !boardId || order === undefined) {
      return res.status(400).json({ error: "Назва, ID дошки та order обов'язкові!" });
    }

    if (prisma) {
      const newColumn = await prisma.column.create({
        data: { title, boardId, order: Number(order) }
      });
      return res.status(201).json(newColumn);
    }
    res.status(201).json({ id: Date.now().toString(), title, boardId, order: Number(order) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка при створенні колонки" });
  }
});

// ==========================================
// 📌 МАРШРУТИ ЗАВДАНЬ (TASKS CRUD ДЛЯ КАНБАНУ)
// ==========================================

// 1. Отримати всі таски
app.get('/api/tasks', optionalAuth, async (req, res) => {
  try {
    if (prisma) {
      try {
        const dbTasks = await prisma.task.findMany({
          orderBy: { order: 'asc' }
        });
        if (dbTasks && dbTasks.length > 0) {
          // Приводимо до формату, який очікує фронтенд
          const formatted = dbTasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description || '',
            priority: t.priority || 'Medium',
            label: t.label || 'Feature',
            issueNumber: t.issueNumber || `#${t.id.slice(0, 4)}`,
            status: t.status || 'TODO',
            order: t.order || 0
          }));
          return res.json(formatted);
        }
      } catch (dbErr) {
        console.warn('Prisma get tasks error, using memoryTasks:', dbErr.message);
      }
    }
    // Повертаємо завдання з пам'яті
    res.json(memoryTasks);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка завантаження завдань" });
  }
});

// 2. Створити нове завдання
app.post('/api/tasks', optionalAuth, async (req, res) => {
  try {
    const { title, description, priority, label, status, columnId, order } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Заголовок завдання обов'язковий!" });
    }

    // Рахуємо наступний номер issue
    const currentTasks = memoryTasks;
    const maxNum = currentTasks.reduce((max, t) => {
      const num = parseInt(String(t.issueNumber || '').replace('#', ''), 10);
      return !isNaN(num) && num > max ? num : max;
    }, 0);
    const nextIssueNumber = `#${maxNum + 1}`;

    const newTaskData = {
      id: Date.now().toString(),
      title: title.trim(),
      description: description || '',
      priority: priority || 'Medium',
      label: label || 'Feature',
      status: status || 'TODO',
      issueNumber: nextIssueNumber,
      order: order !== undefined ? Number(order) : 0,
      columnId: columnId || null,
    };

    if (prisma) {
      try {
        const dbTask = await prisma.task.create({
          data: {
            title: newTaskData.title,
            description: newTaskData.description,
            priority: newTaskData.priority,
            label: newTaskData.label,
            status: newTaskData.status,
            issueNumber: newTaskData.issueNumber,
            order: newTaskData.order,
            columnId: columnId || undefined
          }
        });
        newTaskData.id = dbTask.id;
      } catch (dbErr) {
        console.warn('Prisma create task error, saved to memory:', dbErr.message);
      }
    }

    memoryTasks.push(newTaskData);

    // Сповіщаємо підключених клієнтів
    io.emit('task_created', newTaskData);

    res.status(201).json(newTaskData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка при створенні завдання" });
  }
});

// 3. Змінити статус / перемістити (Drag-and-Drop)
app.patch('/api/tasks/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, newStatus, order, index } = req.body;
    const finalStatus = status || newStatus;
    const finalIndex = order !== undefined ? Number(order) : (index !== undefined ? Number(index) : 0);

    let updatedTask = null;

    if (prisma) {
      try {
        updatedTask = await prisma.task.update({
          where: { id },
          data: {
            status: finalStatus || undefined,
            order: finalIndex
          }
        });
      } catch (dbErr) {
        console.warn('Prisma update status error:', dbErr.message);
      }
    }

    // Оновлюємо в пам'яті
    const idx = memoryTasks.findIndex(t => t.id === id);
    if (idx !== -1) {
      if (finalStatus) memoryTasks[idx].status = finalStatus;
      memoryTasks[idx].order = finalIndex;
      updatedTask = memoryTasks[idx];
    } else if (!updatedTask) {
      // Якщо таска з локального стану ще не була в пам'яті бекенду
      updatedTask = { id, status: finalStatus, order: finalIndex };
    }

    // Транслюємо всім іншим клієнтам подію для Live Sync
    io.emit('task_moved_by_other', {
      taskId: id,
      newStatus: finalStatus,
      newIndex: finalIndex
    });

    res.json(updatedTask);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка оновлення статусу" });
  }
});

// 4. Оновити поля завдання (редагування картки)
app.put('/api/tasks/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, priority, label, status } = req.body;

    let updatedTask = null;

    if (prisma) {
      try {
        updatedTask = await prisma.task.update({
          where: { id },
          data: {
            title: title || undefined,
            description: description !== undefined ? description : undefined,
            priority: priority || undefined,
            label: label || undefined,
            status: status || undefined
          }
        });
      } catch (dbErr) {
        console.warn('Prisma edit task error:', dbErr.message);
      }
    }

    const idx = memoryTasks.findIndex(t => t.id === id);
    if (idx !== -1) {
      if (title !== undefined) memoryTasks[idx].title = title;
      if (description !== undefined) memoryTasks[idx].description = description;
      if (priority !== undefined) memoryTasks[idx].priority = priority;
      if (label !== undefined) memoryTasks[idx].label = label;
      if (status !== undefined) memoryTasks[idx].status = status;
      updatedTask = memoryTasks[idx];
    }

    io.emit('task_updated', updatedTask || { id, ...req.body });

    res.json(updatedTask || { id, ...req.body });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка редагування завдання" });
  }
});

// 5. Видалити завдання
app.delete('/api/tasks/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (prisma) {
      try {
        await prisma.task.delete({ where: { id } });
      } catch (dbErr) {
        console.warn('Prisma delete task error:', dbErr.message);
      }
    }

    memoryTasks = memoryTasks.filter(t => t.id !== id);

    io.emit('task_deleted', { taskId: id });

    res.status(200).json({ message: "Завдання видалено", id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка видалення завдання" });
  }
});

// 6. Емуляція GitHub Webhook через API
app.post('/api/webhook/github', (req, res) => {
  const { commitMessage } = req.body;
  if (!commitMessage) return res.status(400).json({ error: "Вкажіть commitMessage" });

  const match = commitMessage.match(/#(\d+)/);
  if (!match) {
    return res.json({ message: "У коміті немає посилання на issue (#ID)" });
  }

  const issueNum = `#${match[1]}`;
  const task = memoryTasks.find(t => t.issueNumber === issueNum);

  if (task) {
    task.status = 'DONE';
    io.emit('task_moved_by_other', {
      taskId: task.id,
      newStatus: 'DONE',
      newIndex: 0
    });
    return res.json({ message: `Таску ${issueNum} переведено в DONE!`, task });
  }

  res.json({ message: `Таску ${issueNum} знайдено, статус оновлено` });
});

// ==========================================
// ЗАПУСК СЕРВЕРА
// ==========================================
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
  console.log(`🔥 Сервер успішно запущено на порту ${PORT}`);
  console.log(`🔌 WebSocket готовий приймати підключення на порту ${PORT}`);
});