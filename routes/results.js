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

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { subject_id, score, total } = req.body;
    const percentage = Math.round((score / total) * 100);
    const result = await pool.query(
      'INSERT INTO results (user_id, subject_id, score, total, percentage) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.user.id, subject_id, score, total, percentage]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, s.name as subject_name
      FROM results r
      JOIN subjects s ON s.id = r.subject_id
      WHERE r.user_id = $1
      ORDER BY r.completed_at DESC`, [req.user.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Сохранить статистику по вопросам после теста
router.post('/question-stats', authMiddleware, async (req, res) => {
  try {
    const { answers } = req.body; // [{ question_id, correct }]
    for (const a of answers) {
      await pool.query(`
        INSERT INTO question_stats (user_id, question_id, correct_count, wrong_count, mastery_level, last_answered_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (user_id, question_id)
        DO UPDATE SET
          correct_count = question_stats.correct_count + $3,
          wrong_count = question_stats.wrong_count + $4,
          mastery_level = LEAST(3, question_stats.mastery_level + $5),
          last_answered_at = NOW()
      `, [req.user.id, a.question_id, a.correct ? 1 : 0, a.correct ? 0 : 1, a.correct ? 1 : 0]);

      // Отдельный журнал каждой попытки — здесь считается порядок во времени,
      // чего не хватает у correct_count/wrong_count (те просто суммируют).
      await pool.query(
        'INSERT INTO question_attempts (user_id, question_id, correct) VALUES ($1, $2, $3)',
        [req.user.id, a.question_id, a.correct]
      );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Получить статистику по вопросам предмета (для взвешенного рандома и цифр)
router.get('/question-stats', authMiddleware, async (req, res) => {
  try {
    const { subject_id } = req.query;
    let query = `
      SELECT qs.question_id, qs.correct_count, qs.wrong_count
      FROM question_stats qs
      JOIN questions q ON q.id = qs.question_id
      WHERE qs.user_id = $1
    `;
    const params = [req.user.id];
    if (subject_id) { query += ' AND q.subject_id = $2'; params.push(subject_id); }

    const result = await pool.query(query, params);
    const map = {};
    result.rows.forEach(r => { map[r.question_id] = { correct: r.correct_count, wrong: r.wrong_count }; });
    res.json(map);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Прогресс освоения предмета: сколько вопросов на каждом уровне (0/1/2/3) + средний результат по последним попыткам
router.get('/mastery/:subjectId', authMiddleware, async (req, res) => {
  try {
    const { subjectId } = req.params;

    const totalResult = await pool.query(
      "SELECT COUNT(*) FROM questions WHERE subject_id = $1 AND type = 'mcq'",
      [subjectId]
    );
    const total = parseInt(totalResult.rows[0].count);

    const levelsResult = await pool.query(`
      SELECT qs.mastery_level, COUNT(*) as cnt
      FROM question_stats qs
      JOIN questions q ON q.id = qs.question_id
      WHERE q.subject_id = $1 AND q.type = 'mcq' AND qs.user_id = $2
      GROUP BY qs.mastery_level
    `, [subjectId, req.user.id]);

    // Кумулятивно: "дошло хотя бы до уровня N", а не "ровно на уровне N".
    // Это важно для полос прогресса — жёлтая физически всегда внутри красной,
    // зелёная — внутри жёлтой, раз уровень 2 невозможен без уже пройденного уровня 1.
    let atLeast1 = 0, atLeast2 = 0, atLeast3 = 0;
    for (const row of levelsResult.rows) {
      const lvl = parseInt(row.mastery_level);
      const cnt = parseInt(row.cnt);
      if (lvl >= 1) atLeast1 += cnt;
      if (lvl >= 2) atLeast2 += cnt;
      if (lvl >= 3) atLeast3 += cnt;
    }

    const recentResult = await pool.query(`
      SELECT percentage FROM results
      WHERE user_id = $1 AND subject_id = $2
      ORDER BY completed_at DESC LIMIT 10
    `, [req.user.id, subjectId]);

    const recentAvg = recentResult.rows.length > 0
      ? Math.round(recentResult.rows.reduce((sum, r) => sum + r.percentage, 0) / recentResult.rows.length)
      : null;

    res.json({
      total,
      level1_percent: total > 0 ? Math.round((atLeast1 / total) * 100) : 0,
      level2_percent: total > 0 ? Math.round((atLeast2 / total) * 100) : 0,
      level3_percent: total > 0 ? Math.round((atLeast3 / total) * 100) : 0,
      recent_avg: recentAvg
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Таблица лидеров: очки = сумма mastery_level по всем вопросам пользователя,
// внутри его собственной группы (факультет + курс + язык), либо любой явно
// запрошенной группы (только для admin/superadmin).
router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const explicitFilter = req.query.faculty_id || req.query.course || req.query.language;
    let facultyId = req.query.faculty_id;
    let course = req.query.course;
    let language = req.query.language;
    const showAll = req.query.all === '1';

    // По умолчанию (без явного запроса "все" и без явных фильтров) — своя группа.
    if (!showAll && !explicitFilter) {
      const meResult = await pool.query('SELECT faculty_id, course, language FROM users WHERE id = $1', [req.user.id]);
      const me = meResult.rows[0];
      facultyId = me.faculty_id;
      course = me.course;
      language = me.language;
    }

    const params = [];
    let whereClause = '';
    if (facultyId) { params.push(facultyId); whereClause += ` AND u.faculty_id = $${params.length}`; }
    if (course) { params.push(course); whereClause += ` AND u.course = $${params.length}`; }
    if (language) { params.push(language); whereClause += ` AND u.language = $${params.length}`; }

    // Считаются все зарегистрированные (студенты, админы, суперадмины) — все они
    // здесь в первую очередь студенты университета, помогающие с платформой.
    const result = await pool.query(`
      SELECT
        u.id, u.name, u.course, u.language, f.name as faculty_name,
        COALESCE(SUM(qs.mastery_level), 0) as points
      FROM users u
      LEFT JOIN question_stats qs ON qs.user_id = u.id
      LEFT JOIN faculties f ON f.id = u.faculty_id
      WHERE 1=1 ${whereClause}
      GROUP BY u.id, u.name, u.course, u.language, f.name
      ORDER BY points DESC, u.name ASC
    `, params);

    const isFiltered = !!(facultyId || course || language);
    const langLabels = { ru: 'РУ', tj: 'ТЧ', en: 'АНГ' };

    const rows = result.rows.map((r, i) => ({
      rank: i + 1,
      id: r.id,
      name: r.name,
      points: parseInt(r.points),
      is_me: r.id === req.user.id,
      group_label: isFiltered ? null : `${r.faculty_name || '—'} · ${r.course} курс · ${langLabels[r.language] || r.language}`
    }));

    res.json({ rows, faculty_id: facultyId, course, language, is_global: !isFiltered });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Личные очки текущего пользователя — для профиля
router.get('/my-points', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COALESCE(SUM(mastery_level), 0) as points
      FROM question_stats
      WHERE user_id = $1
    `, [req.user.id]);
    res.json({ points: parseInt(result.rows[0].points) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Глобальный рейтинг: процент от максимально возможных очков по ВСЕМ предметам,
// которые пользователь когда-либо пытался решать (не только своей группы) —
// это справедливо уравнивает тех, у кого 50 вопросов, и тех, у кого 1000,
// потому что и числитель (набранные очки), и знаменатель (максимум = total*3)
// растут вместе для одного и того же человека.
router.get('/leaderboard/global', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id, u.name, u.course, u.language, f.name as faculty_name,
        COALESCE(SUM(qs.mastery_level), 0) as earned_points,
        COALESCE(COUNT(DISTINCT qs.question_id), 0) * 3 as max_possible_points
      FROM users u
      LEFT JOIN question_stats qs ON qs.user_id = u.id
      LEFT JOIN faculties f ON f.id = u.faculty_id
      GROUP BY u.id, u.name, u.course, u.language, f.name
      HAVING COUNT(DISTINCT qs.question_id) > 0
      ORDER BY (COALESCE(SUM(qs.mastery_level), 0)::float / NULLIF(COUNT(DISTINCT qs.question_id) * 3, 0)) DESC, u.name ASC
    `);

    const langLabels = { ru: 'РУ', tj: 'ТЧ', en: 'АНГ' };

    const rows = result.rows.map((r, i) => {
      const earned = parseInt(r.earned_points);
      const max = parseInt(r.max_possible_points);
      const percent = max > 0 ? Math.round((earned / max) * 100000) / 1000 : 0;
      return {
        rank: i + 1,
        id: r.id,
        name: r.name,
        percent,
        earned,
        max,
        is_me: r.id === req.user.id,
        group_label: `${r.faculty_name || '—'} · ${r.course} курс · ${langLabels[r.language] || r.language}`
      };
    });

    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Список реально существующих групп (факультет+курс+язык), где есть хотя бы
// один зарегистрированный студент — для выпадающего списка на странице ТЛ.
router.get('/leaderboard/groups', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT u.faculty_id, u.course, u.language, f.name as faculty_name
      FROM users u
      LEFT JOIN faculties f ON f.id = u.faculty_id
      WHERE u.faculty_id IS NOT NULL AND u.course IS NOT NULL AND u.language IS NOT NULL
      ORDER BY f.name, u.course, u.language
    `);

    const langLabels = { ru: 'РУ', tj: 'ТЧ', en: 'АНГ' };

    const groups = result.rows.map(r => ({
      faculty_id: r.faculty_id,
      course: r.course,
      language: r.language,
      label: `${r.faculty_name || '—'} · ${r.course} курс · ${langLabels[r.language] || r.language}`
    }));

    res.json(groups);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Карточки статистики по каждому вопросу предмета — для раздела "Разбор".
// Отдаёт даже вопросы без единой попытки (correct/wrong = 0), чтобы карточная
// сетка показывала номера подряд без пропусков.
// Потенциал правильности (ПП): последние 4 попытки, свежие весят больше.
// Меньше 2 реальных ответов — карточка серая, ПП не считается вовсе.
// Отсутствующая позиция (только для x3/x4) даёт половину её веса —
// не лучший и не худший исход, нейтральная презумпция.
function computePotential(attempts) {
  if (attempts.length < 2) return { pp: null, tier: 'gray' };

  const weights = [35, 30, 20, 15];
  let pp = 0;
  for (let i = 0; i < 4; i++) {
    if (attempts[i] !== undefined) {
      pp += weights[i] * (attempts[i] ? 1 : 0);
    } else {
      pp += weights[i] * 0.5;
    }
  }

  let tier;
  if (pp === 0) tier = 'black';
  else if (pp < 50) tier = 'red';
  else if (pp < 70) tier = 'yellow';
  else if (pp < 85) tier = 'green';
  else tier = 'blue';

  return { pp, tier };
}

router.get('/question-cards/:subjectId', authMiddleware, async (req, res) => {
  try {
    const { subjectId } = req.params;

    const result = await pool.query(`
      SELECT q.id, q.question, q.topic_id, t.name as topic_name,
        COALESCE(qs.correct_count, 0) as correct_count,
        COALESCE(qs.wrong_count, 0) as wrong_count,
        COALESCE(qs.mastery_level, 0) as mastery_level
      FROM questions q
      LEFT JOIN question_stats qs ON qs.question_id = q.id AND qs.user_id = $2
      LEFT JOIN topics t ON t.id = q.topic_id
      WHERE q.subject_id = $1 AND q.type = 'mcq'
      ORDER BY q.id ASC
    `, [subjectId, req.user.id]);

    const attemptsResult = await pool.query(`
      SELECT question_id, correct
      FROM question_attempts qa
      WHERE qa.user_id = $2 AND qa.question_id IN (
        SELECT id FROM questions WHERE subject_id = $1 AND type = 'mcq'
      )
      ORDER BY question_id, answered_at DESC
    `, [subjectId, req.user.id]);

    const attemptsByQuestion = {};
    for (const row of attemptsResult.rows) {
      if (!attemptsByQuestion[row.question_id]) attemptsByQuestion[row.question_id] = [];
      if (attemptsByQuestion[row.question_id].length < 4) {
        attemptsByQuestion[row.question_id].push(row.correct);
      }
    }

    const cards = result.rows.map((row, i) => {
      const { pp, tier } = computePotential(attemptsByQuestion[row.id] || []);
      return {
        number: i + 1,
        question_id: row.id,
        question: row.question,
        topic_id: row.topic_id,
        topic_name: row.topic_name,
        correct: parseInt(row.correct_count),
        wrong: parseInt(row.wrong_count),
        mastery_level: parseInt(row.mastery_level),
        pp, pp_tier: tier
      };
    });

    res.json(cards);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;