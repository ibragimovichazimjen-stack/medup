const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Недействительный токен' }); }
}

// Жёсткая проверка id=1 — не роль, а конкретный человек, независимо от того,
// сколько ещё superadmin появится в системе в будущем.
function ownerOnly(req, res, next) {
  if (req.user.id !== 1) return res.status(403).json({ error: 'Нет доступа' });
  next();
}

router.get('/budget', authMiddleware, ownerOnly, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM budget_entries ORDER BY entry_date DESC, id DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/budget/summary', authMiddleware, ownerOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN entry_type = 'income' THEN amount ELSE 0 END), 0) as total_income,
        COALESCE(SUM(CASE WHEN entry_type = 'expense' THEN amount ELSE 0 END), 0) as total_expense
      FROM budget_entries
    `);
    const row = result.rows[0];
    const income = parseFloat(row.total_income);
    const expense = parseFloat(row.total_expense);
    res.json({ income, expense, balance: income - expense });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/budget', authMiddleware, ownerOnly, async (req, res) => {
  try {
    const { description, amount, category, entry_type, entry_date } = req.body;
    if (!description || !description.trim()) return res.status(400).json({ error: 'Нужно описание' });
    if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Некорректная сумма' });
    if (!['income', 'expense'].includes(entry_type)) return res.status(400).json({ error: 'Некорректный тип' });

    const result = await pool.query(
      'INSERT INTO budget_entries (description, amount, category, entry_type, entry_date, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [description.trim(), parseFloat(amount), category || 'Прочее', entry_type, entry_date || new Date().toISOString().slice(0, 10), req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/budget/:id', authMiddleware, ownerOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM budget_entries WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;