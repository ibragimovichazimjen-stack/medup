const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const pool = require('../db');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: { error: 'Слишком много попыток входа. Попробуй снова через 15 минут.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_CODE = process.env.ADMIN_CODE;
const SUPERADMIN_CODE = process.env.SUPERADMIN_CODE;

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Недействительный токен' }); }
}

function superadminOnly(req, res, next) {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Нет доступа' });
  next();
}

// Защита пользователя id=1 (владелец платформы) от изменений другими суперадминами
function protectOwner(req, res, next) {
  const targetId = parseInt(req.params.id);
  if (targetId === 1 && req.user.id !== 1) {
    return res.status(403).json({ error: 'Этого пользователя нельзя изменять' });
  }
  next();
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, course, facultyId, adminCode, phone } = req.body;
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Такой логин уже используется' });

    const hashed = await bcrypt.hash(password, 10);
    let role = 'student';
    if (adminCode === SUPERADMIN_CODE) role = 'superadmin';
    else if (adminCode === ADMIN_CODE) role = 'admin';

    const result = await pool.query(
      'INSERT INTO users (name, email, password, course, faculty_id, role, phone) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, email, course, faculty_id, role, phone',
      [name, email, hashed, course || 1, facultyId || null, role, phone || null]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Пользователь не найден' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, course: user.course, faculty_id: user.faculty_id, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, u.course, u.role, u.faculty_id, u.phone, u.chat_nickname, u.language, f.name as faculty_name
      FROM users u LEFT JOIN faculties f ON f.id = u.faculty_id
      WHERE u.id = $1`, [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Не найден' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/users', authMiddleware, superadminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, u.course, u.role, u.faculty_id, u.language, u.created_at, f.name as faculty_name
      FROM users u LEFT JOIN faculties f ON f.id = u.faculty_id
      ORDER BY u.created_at DESC`);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/users/:id/role', authMiddleware, superadminOnly, protectOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    if (!['student', 'admin', 'superadmin'].includes(role)) return res.status(400).json({ error: 'Неверная роль' });
    if (parseInt(id) === req.user.id) return res.status(400).json({ error: 'Нельзя изменить свою роль' });
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/users/:id/profile', authMiddleware, superadminOnly, protectOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const { course, facultyId, language } = req.body;
    await pool.query('UPDATE users SET course = $1, faculty_id = $2, language = $3 WHERE id = $4', [course, facultyId || null, language || 'ru', id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


router.delete('/users/:id', authMiddleware, superadminOnly, protectOwner, async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) return res.status(400).json({ error: 'Нельзя удалить свой аккаунт' });
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Суперадмин меняет пароль любого пользователя (кроме id=1, если это не он сам)
router.put('/users/:id/password', authMiddleware, superadminOnly, protectOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Пользователь меняет свои собственные данные (имя, логин, телефон, никнейм чата)
router.put('/me/profile', authMiddleware, async (req, res) => {
  try {
    const { name, email, phone, chat_nickname } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Имя не может быть пустым' });
    if (!email || !email.trim()) return res.status(400).json({ error: 'Логин не может быть пустым' });
    if (!chat_nickname || !chat_nickname.trim()) return res.status(400).json({ error: 'Никнейм чата не может быть пустым' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email.trim(), req.user.id]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Такой логин уже используется' });

    await pool.query(
      'UPDATE users SET name = $1, email = $2, phone = $3, chat_nickname = $4 WHERE id = $5',
      [name.trim(), email.trim(), phone ? phone.trim() : null, chat_nickname.trim(), req.user.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Пользователь меняет свой собственный пароль (требует текущий пароль)
router.put('/me/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });

    const result = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword || '', result.rows[0].password);
    if (!valid) return res.status(400).json({ error: 'Текущий пароль неверен' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


module.exports = router;