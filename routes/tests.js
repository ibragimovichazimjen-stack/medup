const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { parseTxtFile } = require('../utils/parser');
const pool = require('../db');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;


function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Недействительный токен' }); }
}

function adminOnly(req, res, next) {
  if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Нет доступа' });
  next();
}


// Список факультетов
router.get('/faculties', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM faculties ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Загрузка файла
router.post('/upload', authMiddleware, adminOnly, upload.single('file'), async (req, res) => {
  try {
    const content = fs.readFileSync(req.file.path, 'utf8');
    const parsed = parseTxtFile(content);
    fs.unlinkSync(req.file.path);

    const subjectName = Buffer.from(req.file.originalname, 'latin1')
      .toString('utf8').replace('.txt', '');

    const { faculty_id, course, language } = req.body;

    const subjectResult = await pool.query(
      'INSERT INTO subjects (name, faculty_id, course, language) VALUES ($1, $2, $3, $4) RETURNING id',
      [subjectName, faculty_id || null, course || 1, language || 'ru']
    );

    const subjectId = subjectResult.rows[0].id;

    for (const q of parsed.mcq) {
      const qResult = await pool.query(
        'INSERT INTO questions (subject_id, type, question) VALUES ($1, $2, $3) RETURNING id',
        [subjectId, 'mcq', q.question]
      );
      const questionId = qResult.rows[0].id;
      for (const ans of q.answers) {
        await pool.query(
          'INSERT INTO answers (question_id, text, is_correct) VALUES ($1, $2, $3)',
          [questionId, ans.text, ans.correct]
        );
      }
    }

    for (const q of parsed.open) {
      await pool.query(
        'INSERT INTO questions (subject_id, type, question) VALUES ($1, $2, $3)',
        [subjectId, 'open', q.question]
      );
    }

    res.json({ mcq: parsed.mcq.length, open: parsed.open.length, subject: subjectName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Список предметов с фильтрацией
router.get('/subjects', authMiddleware, async (req, res) => {
  try {
    const { faculty_id, course, language, mode } = req.query;

    // По умолчанию — и для студента, и для админа/суперадмина, если явно не запрошен
    // просмотр всех предметов (mode=all), показываем только предметы, соответствующие
    // собственному факультету/курсу пользователя. Язык не сужаем автоматически —
    // студент сам выбирает язык на странице (три ряда), поэтому здесь он остаётся
    // фильтром по явному запросу, а не жёстким ограничением.
    let effectiveFacultyId = faculty_id;
    let effectiveCourse = course;
    let effectiveLanguage = language;

    if (mode !== 'all') {
      const userResult = await pool.query('SELECT faculty_id, course, language FROM users WHERE id = $1', [req.user.id]);
      if (userResult.rows.length > 0) {
        effectiveFacultyId = userResult.rows[0].faculty_id || faculty_id;
        effectiveCourse = userResult.rows[0].course || course;
        effectiveLanguage = userResult.rows[0].language || language;
      }
    }

    let query = `
      SELECT s.id, s.name, s.course, s.language,
        f.name as faculty_name,
        COUNT(CASE WHEN q.type = 'mcq' THEN 1 END) as mcq_count,
        COUNT(CASE WHEN q.type = 'open' THEN 1 END) as open_count
      FROM subjects s
      LEFT JOIN faculties f ON f.id = s.faculty_id
      LEFT JOIN questions q ON q.subject_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (effectiveFacultyId) { params.push(effectiveFacultyId); query += ` AND s.faculty_id = $${params.length}`; }
    if (effectiveCourse) { params.push(effectiveCourse); query += ` AND s.course = $${params.length}`; }
    if (effectiveLanguage) { params.push(effectiveLanguage); query += ` AND s.language = $${params.length}`; }

    query += ' GROUP BY s.id, s.name, s.course, s.language, f.name ORDER BY s.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Удалить предмет
router.delete('/subjects/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM question_stats WHERE question_id IN (SELECT id FROM questions WHERE subject_id = $1)', [id]);
    await pool.query('DELETE FROM results WHERE subject_id = $1', [id]);
    await pool.query('DELETE FROM answers WHERE question_id IN (SELECT id FROM questions WHERE subject_id = $1)', [id]);
    await pool.query('DELETE FROM questions WHERE subject_id = $1', [id]);
    await pool.query('DELETE FROM subjects WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Вопросы по предмету
router.get('/questions', async (req, res) => {
  try {
    const { subject_id } = req.query;
    let query = `
      SELECT q.id, q.question, q.type, q.topic_id, a.text, a.is_correct
      FROM questions q
      LEFT JOIN answers a ON a.question_id = q.id
    `;
    const params = [];
    if (subject_id) { query += ' WHERE q.subject_id = $1'; params.push(subject_id); }
    query += ' ORDER BY q.id, a.id';

    const result = await pool.query(query, params);
    const mcqMap = new Map();
    const openList = [];

    for (const row of result.rows) {
      if (row.type === 'mcq') {
        if (!mcqMap.has(row.id)) mcqMap.set(row.id, { id: row.id, question: row.question, topic_id: row.topic_id, answers: [] });
        if (row.text) mcqMap.get(row.id).answers.push({ text: row.text, correct: row.is_correct });
      } else if (row.type === 'open') {
        if (!openList.some(o => o.question === row.question)) openList.push({ question: row.question });
      }
    }

    res.json({ mcq: [...mcqMap.values()], open: openList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Получить метаданные одного предмета (для редактора)
router.get('/subjects/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id, s.name, s.course, s.language, s.faculty_id, f.name as faculty_name
      FROM subjects s
      LEFT JOIN faculties f ON f.id = s.faculty_id
      WHERE s.id = $1`, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Предмет не найден' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Обновить метаданные предмета (название, курс, факультет, язык)
router.put('/subjects/:id', authMiddleware, adminOnly, async (req, res) => {
    try {
    const { name, course, faculty_id, language } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Название не может быть пустым' });

    await pool.query(
      'UPDATE subjects SET name = $1, course = $2, faculty_id = $3, language = $4 WHERE id = $5',
      [name.trim(), course || 1, faculty_id || null, language || 'ru', req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Все MCQ-вопросы предмета вместе с ID вариантов (для редактора)
router.get('/subjects/:id/edit-questions', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT q.id as question_id, q.question,
        a.id as answer_id, a.text, a.is_correct
      FROM questions q
      LEFT JOIN answers a ON a.question_id = q.id
      WHERE q.subject_id = $1 AND q.type = 'mcq'
      ORDER BY q.id, a.id
    `, [req.params.id]);

    const map = new Map();
    for (const row of result.rows) {
      if (!map.has(row.question_id)) map.set(row.question_id, { id: row.question_id, question: row.question, answers: [] });
      if (row.answer_id) map.get(row.question_id).answers.push({ id: row.answer_id, text: row.text, correct: row.is_correct });
    }
    res.json([...map.values()]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Добавить новый вопрос с вариантами
router.post('/subjects/:id/questions', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { question, answers } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'Текст вопроса не может быть пустым' });
    if (!answers || answers.length < 2) return res.status(400).json({ error: 'Нужно минимум 2 варианта ответа' });
    if (!answers.some(a => a.correct)) return res.status(400).json({ error: 'Отметь хотя бы один правильный вариант' });

    const qResult = await pool.query(
      'INSERT INTO questions (subject_id, type, question) VALUES ($1, $2, $3) RETURNING id',
      [req.params.id, 'mcq', question.trim()]
    );
    const questionId = qResult.rows[0].id;

    for (const a of answers) {
      await pool.query(
        'INSERT INTO answers (question_id, text, is_correct) VALUES ($1, $2, $3)',
        [questionId, a.text.trim(), !!a.correct]
      );
    }

    res.json({ success: true, question_id: questionId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Обновить вопрос целиком: текст + полный набор вариантов (старые варианты удаляются, новые вставляются заново)
router.put('/questions/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { question, answers } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'Текст вопроса не может быть пустым' });
    if (!answers || answers.length < 2) return res.status(400).json({ error: 'Нужно минимум 2 варианта ответа' });
    if (!answers.some(a => a.correct)) return res.status(400).json({ error: 'Отметь хотя бы один правильный вариант' });

    await pool.query('UPDATE questions SET question = $1 WHERE id = $2', [question.trim(), req.params.id]);
    await pool.query('DELETE FROM answers WHERE question_id = $1', [req.params.id]);

    for (const a of answers) {
      await pool.query(
        'INSERT INTO answers (question_id, text, is_correct) VALUES ($1, $2, $3)',
        [req.params.id, a.text.trim(), !!a.correct]
      );
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Удалить вопрос целиком (и его варианты, и связанную статистику/историю ответов)
router.delete('/questions/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM question_stats WHERE question_id = $1', [id]);
    await pool.query('DELETE FROM answers WHERE question_id = $1', [id]);
    await pool.query('DELETE FROM questions WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Темы конкретного предмета — для вкладки "Темы" в редакторе
router.get('/subjects/:id/topics', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.id, t.name, COUNT(q.id) as question_count
      FROM topics t
      LEFT JOIN questions q ON q.topic_id = t.id
      WHERE t.subject_id = $1
      GROUP BY t.id, t.name
      ORDER BY t.created_at ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/subjects/:id/topics', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Название темы не может быть пустым' });
    const result = await pool.query(
      'INSERT INTO topics (subject_id, name) VALUES ($1, $2) RETURNING *',
      [req.params.id, name.trim()]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/topics/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM topics WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Вопросы предмета вместе с их текущей темой (или null) — для сборки тем в редакторе
router.get('/subjects/:id/questions-with-topics', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT q.id, q.question, q.topic_id
      FROM questions q
      WHERE q.subject_id = $1 AND q.type = 'mcq'
      ORDER BY q.id ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Назначить/снять тему сразу для нескольких вопросов одним запросом.
// Путь намеренно НЕ вложен под /questions/ — там уже есть PUT /questions/:id
// (правка текста вопроса), и Express сопоставлял этот запрос туда же,
// приняв "assign-topic" за значение :id, отчего сохранение тихо проваливалось.
router.put('/question-topic', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { question_ids, topic_id } = req.body;
    if (!Array.isArray(question_ids) || question_ids.length === 0) {
      return res.status(400).json({ error: 'Нужен хотя бы один вопрос' });
    }
    await pool.query(
      'UPDATE questions SET topic_id = $1 WHERE id = ANY($2::int[])',
      [topic_id || null, question_ids]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;