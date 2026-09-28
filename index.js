require('dotenv').config(); // Завантажуємо посилання з файлу .env
const jwt = require('jsonwebtoken');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');

// Нові імпорти для Prisma 7
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

// Налаштовуємо підключення через адаптер
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();

// Налаштування (щоб фронтенд міг робити запити і ми розуміли JSON)
app.use(cors());
app.use(express.json());

// ==========================================
// 🔐 МАРШРУТИ АВТОРИЗАЦІЇ
// ==========================================

// 1. РЕЄСТРАЦІЯ
app.post('/api/auth/register', async (req, res) => {
  try {
    // Витягуємо дані, які прислав фронтенд
    const { email, password, name } = req.body;

    // Перевіряємо, чи не порожні поля
    if (!email || !password || !name) {
      return res.status(400).json({ error: "Всі поля обов'язкові!" });
    }

    // Перевіряємо, чи є вже такий юзер у базі
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: "Користувач з таким email вже існує!" });
    }

    // Хешуємо (шифруємо) пароль, щоб не зберігати його відкритим
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Створюємо нового юзера в базі даних
    const newUser = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
      },
    });

    // Відповідаємо фронтенду, що все супер
    res.status(201).json({ message: "Користувача успішно зареєстровано!", userId: newUser.id });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка сервера при реєстрації" });
  }
});

// 2. АВТОРИЗАЦІЯ (ЛОГІН)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Шукаємо користувача за email
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(400).json({ error: "Користувача з таким email не знайдено!" });
    }

    // Перевіряємо пароль
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ error: "Невірний пароль!" });
    }

    // Створюємо токен, який буде діяти 1 день
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1d' });

    res.json({ message: "Успішний вхід!", token, userId: user.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка сервера при авторизації" });
  }
});

// ==========================================
// 🛡 МІДЛВАР (ОХОРОНЕЦЬ)
// ==========================================
const authenticateToken = (req, res, next) => {
  // Клієнт має передавати токен у заголовку Authorization
  const authHeader = req.headers['authorization'];
  // Формат заголовка зазвичай такий: "Bearer eyJhbGciOiJIUz..."
  const token = authHeader && authHeader.split(' ')[1]; 

  if (!token) {
    return res.status(401).json({ error: "Доступ заборонено. Немає токена!" });
  }

  // Перевіряємо, чи токен справжній і не прострочений
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Недійсний або прострочений токен!" });

    req.user = user; // Зберігаємо розшифровані дані (наш userId) у request
    next(); // Пропускаємо запит далі до маршруту
  });
};

// ==========================================
// 📋 МАРШРУТИ ДОШОК
// ==========================================

// Створення нової дошки (зверни увагу на переданий authenticateToken)
app.post('/api/boards', authenticateToken, async (req, res) => {
  try {
    const { title } = req.body;

    if (!title) {
      return res.status(400).json({ error: "Назва дошки обов'язкова!" });
    }

    // Створюємо дошку і прив'язуємо її до юзера
    const newBoard = await prisma.board.create({
      data: {
        title,
        userId: req.user.userId // Цей ID ми дістали з токена завдяки мідлвару!
      }
    });

    res.status(201).json(newBoard);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка при створенні дошки" });
  }
});

// Отримання всіх дошок користувача
app.get('/api/boards', authenticateToken, async (req, res) => {
  try {
    const boards = await prisma.board.findMany({
      where: {
        userId: req.user.userId // Шукаємо тільки дошки поточного юзера
      },
      // include: { columns: true } // Розкоментуємо пізніше, щоб одразу діставати і колонки
    });
    
    res.json(boards);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка при отриманні дошок" });
  }
});

// ==========================================
// 🗂 МАРШРУТИ КОЛОНОК
// ==========================================

app.post('/api/columns', authenticateToken, async (req, res) => {
  try {
    const { title, boardId, order } = req.body;

    if (!title || !boardId || order === undefined) {
      return res.status(400).json({ error: "Назва, ID дошки та order обов'язкові!" });
    }

    // Перевіряємо, чи існує дошка і чи належить вона поточному юзеру
    const board = await prisma.board.findFirst({
      where: { id: boardId, userId: req.user.userId }
    });

    if (!board) {
      return res.status(403).json({ error: "Дошку не знайдено або доступ заборонено!" });
    }

    // Створюємо колонку
    const newColumn = await prisma.column.create({
      data: { 
        title, 
        boardId,
        order: Number(order) 
      }
    });

    res.status(201).json(newColumn);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка при створенні колонки" });
  }
});

// Створюємо таску
app.post('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const { title, description, columnId, order } = req.body;

    if (!title || !columnId || order === undefined) {
      return res.status(400).json({ error: "Назва, ID колонки та order обов'язкові!" });
    }

    // Перевіряємо, чи належить колонка дошці поточного користувача
    const column = await prisma.column.findFirst({
      where: {
        id: columnId,
        board: {
          userId: req.user.userId
        }
      }
    });

    if (!column) {
      return res.status(403).json({ error: "Колонку не знайдено або доступ заборонено!" });
    }

    // Створюємо таску
    const newTask = await prisma.task.create({
      data: {
        title,
        description: description || "",
        columnId,
        order: Number(order)
      }
    });

    res.status(201).json(newTask);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Помилка при створенні завдання" });
  }
});

// ==========================================
// ЗАПУСК СЕРВЕРА
// ==========================================
const PORT = 5001;
app.listen(PORT, () => {
  console.log(`🔥 Сервер успішно запущено на порту ${PORT}`);
});