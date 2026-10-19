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

function superadminOnly(req, res, next) {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Нет доступа' });
  next();
}

// Список версий — доступен всем (публично, как объявления)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.*, u.name as author_name
      FROM versions v
      LEFT JOIN users u ON u.id = v.created_by
      ORDER BY v.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Последняя версия — для плитки на главной
router.get('/latest', async (req, res) => {
  try {
    const result = await pool.query('SELECT version_number FROM versions ORDER BY created_at DESC LIMIT 1');
    res.json(result.rows[0] || { version_number: '1.0' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authMiddleware, superadminOnly, async (req, res) => {
  try {
    const { version_number, title, content } = req.body;
    const result = await pool.query(
      'INSERT INTO versions (version_number, title, content, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [version_number, title, content, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', authMiddleware, superadminOnly, async (req, res) => {
  try {
    const { version_number, title, content } = req.body;
    await pool.query(
      'UPDATE versions SET version_number = $1, title = $2, content = $3, updated_at = NOW() WHERE id = $4',
      [version_number, title, content, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', authMiddleware, superadminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM versions WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;