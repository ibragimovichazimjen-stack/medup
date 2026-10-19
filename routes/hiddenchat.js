const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const { parseTxtFile } = require('../utils/parser');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

const chatUploadDir = path.join(__dirname, '..', 'uploads', 'chat');
if (!fs.existsSync(chatUploadDir)) fs.mkdirSync(chatUploadDir, { recursive: true });

const chatImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, chatUploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const chatFileUpload = multer({
  storage: chatImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isTxt = file.mimetype === 'text/plain' || file.originalname.toLowerCase().endsWith('.txt');
    if (isTxt) cb(null, true);
    else cb(new Error('Разрешены только .txt файлы'));
  }
});



function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Недействительный токен' }); }
}

const CHANNEL_ACCESS = {
  1: ['student', 'admin', 'superadmin'],
  2: ['admin', 'superadmin'],
  3: ['superadmin']
};

function adminOnly(req, res, next) {
  if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Нет доступа' });
  next();
}

function checkChannelAccess(req, res, next) {
  const channelId = parseInt(req.params.id || req.query.channel_id || req.body.channel_id);
  const allowed = CHANNEL_ACCESS[channelId];
  if (!allowed) return res.status(404).json({ error: 'Тема не найдена' });
  if (!allowed.includes(req.user.role)) return res.status(403).json({ error: 'Нет доступа к этой теме' });
  next();
}



// Список тем — только те, к которым есть доступ по роли
router.get('/channels', authMiddleware, async (req, res) => {
  try {
    const allowedIds = Object.keys(CHANNEL_ACCESS).filter(id => CHANNEL_ACCESS[id].includes(req.user.role));
    if (allowedIds.length === 0) return res.json([]);

    const result = await pool.query(`
      SELECT c.id, c.name, c.created_at,
        COUNT(m.id) as message_count,
        MAX(m.created_at) as last_activity
      FROM hidden_chat_channels c
      LEFT JOIN hidden_chat_messages m ON m.channel_id = c.id
      WHERE c.id = ANY($1::int[])
      GROUP BY c.id, c.name, c.created_at
      ORDER BY c.id ASC
    `, [allowedIds]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});



router.get('/messages', authMiddleware, checkChannelAccess, async (req, res) => {
  try {
    const { channel_id } = req.query;

    const result = await pool.query(`
      SELECT
        m.id, m.user_id, m.nickname, m.content, m.image_url, m.file_url, m.file_name, m.created_at, m.reply_to_id,
        m.review_status,
        u.name as real_name,
        rm.nickname as reply_nickname, rm.content as reply_content,
        COALESCE((
          SELECT json_agg(json_build_object('emoji', r.emoji, 'count', r.cnt, 'reacted', r.reacted))
          FROM (
            SELECT emoji, COUNT(*) as cnt, BOOL_OR(user_id = $2) as reacted
            FROM hidden_chat_reactions
            WHERE message_id = m.id
            GROUP BY emoji
          ) r
        ), '[]') as reactions
      FROM hidden_chat_messages m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN hidden_chat_messages rm ON rm.id = m.reply_to_id
      WHERE m.channel_id = $1
      ORDER BY m.created_at ASC
    `, [channel_id, req.user.id]);

    const isModerator = ['admin', 'superadmin'].includes(req.user.role);

    const messages = result.rows.map(row => {
      const msg = {
        id: row.id,
        nickname: row.nickname,
        content: row.content,
        image_url: row.image_url,
        file_url: row.file_url,
        file_name: row.file_name,
        review_status: row.review_status,
        created_at: row.created_at,
        reply_to_id: row.reply_to_id,
        reply_nickname: row.reply_nickname,
        reply_content: row.reply_content,
        reactions: row.reactions,
        can_delete: row.user_id === req.user.id || isModerator,
        is_own: row.user_id === req.user.id
      };
      if (isModerator) msg.real_name = row.real_name;
      return msg;
    });

    res.json(messages);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/messages', authMiddleware, checkChannelAccess, async (req, res) => {
  try {
    const { content, nickname, channel_id, reply_to_id, file_url, file_name, file_faculty_id, file_course, file_language } = req.body;
    const trimmedContent = (content || '').trim();
    if (!trimmedContent && !file_url) return res.status(400).json({ error: 'Пустое сообщение' });
    if (!nickname || !nickname.trim()) return res.status(400).json({ error: 'Нет никнейма' });
    if (file_url && parseInt(channel_id) !== 1 && parseInt(channel_id) !== 2) return res.status(403).json({ error: 'Файлы можно отправлять только в Общем чате или в Администрации' });

    const result = await pool.query(
      'INSERT INTO hidden_chat_messages (user_id, nickname, content, channel_id, reply_to_id, file_url, file_name, file_faculty_id, file_course, file_language) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [req.user.id, nickname.trim(), trimmedContent, channel_id, reply_to_id || null, file_url || null, file_name || null, file_faculty_id || null, file_course || null, file_language || null]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/upload-file', authMiddleware, (req, res) => {
  chatFileUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const channelId = req.body.channel_id ? parseInt(req.body.channel_id) : null;
    if (channelId !== 1 && channelId !== 2) {
      return res.status(403).json({ error: 'Файлы можно отправлять только в Общем чате или в Администрации' });
    }

    res.json({ url: `/chat-uploads/${req.file.filename}`, name: req.file.originalname });
  });
});


// Удаление своего сообщения ИЛИ модерация (admin/superadmin) в пределах доступных им тем
router.delete('/messages/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const msgResult = await pool.query('SELECT * FROM hidden_chat_messages WHERE id = $1', [id]);
    if (msgResult.rows.length === 0) return res.status(404).json({ error: 'Сообщение не найдено' });
    const message = msgResult.rows[0];

    const allowedRoles = CHANNEL_ACCESS[message.channel_id];
    if (!allowedRoles || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Нет доступа к этой теме' });
    }

    const isOwner = message.user_id === req.user.id;
    const isModerator = ['admin', 'superadmin'].includes(req.user.role);
    if (!isOwner && !isModerator) {
      return res.status(403).json({ error: 'Можно удалять только свои сообщения' });
    }

    await pool.query('UPDATE hidden_chat_messages SET reply_to_id = NULL WHERE reply_to_id = $1', [id]);

    if (message.image_url) {
      const filename = message.image_url.split('/').pop();
      fs.unlink(path.join(chatUploadDir, filename), () => {});
    }
    if (message.file_url) {
      const filename = message.file_url.split('/').pop();
      fs.unlink(path.join(chatUploadDir, filename), () => {});
    }

    await pool.query('DELETE FROM hidden_chat_messages WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Heartbeat присутствия — раз в ~15 сек, пока открыта тема
router.post('/presence', authMiddleware, checkChannelAccess, async (req, res) => {
  try {
    const { channel_id, nickname } = req.body;
    await pool.query(`
      INSERT INTO hidden_chat_presence (user_id, channel_id, nickname, last_seen)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id, channel_id)
      DO UPDATE SET nickname = $3, last_seen = NOW()
    `, [req.user.id, channel_id, nickname]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Кто сейчас онлайн в теме — студентам только никнейм, админам/суперадминам никнейм + имя
router.get('/presence', authMiddleware, checkChannelAccess, async (req, res) => {
  try {
    const { channel_id } = req.query;
    const isModerator = ['admin', 'superadmin'].includes(req.user.role);

    const result = await pool.query(`
      SELECT p.nickname, u.name as real_name
      FROM hidden_chat_presence p
      JOIN users u ON u.id = p.user_id
      WHERE p.channel_id = $1 AND p.last_seen > NOW() - INTERVAL '25 seconds'
      ORDER BY p.last_seen DESC
    `, [channel_id]);

    const online = result.rows.map(r => isModerator ? { nickname: r.nickname, real_name: r.real_name } : { nickname: r.nickname });
    res.json(online);
  } catch (err) { res.status(500).json({ error: err.message }); }
});



router.post('/messages/:id/react', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'Нет эмодзи' });

    const existing = await pool.query(
      'SELECT id, emoji FROM hidden_chat_reactions WHERE message_id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length > 0 && existing.rows[0].emoji === emoji) {
      // Кликнул на свою же реакцию — снимает её
      await pool.query('DELETE FROM hidden_chat_reactions WHERE id = $1', [existing.rows[0].id]);
    } else {
      // Либо реакции ещё не было, либо меняет на другую — удаляем старую (если была) и ставим новую
      await pool.query('DELETE FROM hidden_chat_reactions WHERE message_id = $1 AND user_id = $2', [id, req.user.id]);
      await pool.query(
        'INSERT INTO hidden_chat_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
        [id, req.user.id, emoji]
      );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Прочитать и распарсить файл из сообщения чата (без записи в базу — только для просмотра/редактирования)
router.get('/messages/:id/parse-file', authMiddleware, adminOnly, async (req, res) => {
  try {
    const msgResult = await pool.query('SELECT * FROM hidden_chat_messages WHERE id = $1', [req.params.id]);
    if (msgResult.rows.length === 0) return res.status(404).json({ error: 'Сообщение не найдено' });
    const message = msgResult.rows[0];

    if (!message.file_url) return res.status(400).json({ error: 'В этом сообщении нет файла' });
    if (message.review_status) return res.status(400).json({ error: message.review_status === 'approved' ? 'Этот файл уже одобрен' : 'Этот файл уже отклонён' });

    const filename = message.file_url.split('/').pop();
    const filePath = path.join(chatUploadDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл не найден на сервере' });

    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseTxtFile(content);

    res.json({
      mcq: parsed.mcq,
      open: parsed.open,
      suggestedName: (message.file_name || 'Без названия').replace(/\.txt$/i, ''),
      faculty_id: message.file_faculty_id,
      course: message.file_course,
      language: message.file_language
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Одобрить: создать предмет и загрузить в базу все (возможно отредактированные) вопросы
router.post('/messages/:id/approve', authMiddleware, adminOnly, async (req, res) => {
  try {
    const msgResult = await pool.query('SELECT * FROM hidden_chat_messages WHERE id = $1', [req.params.id]);
    if (msgResult.rows.length === 0) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msgResult.rows[0].review_status) return res.status(400).json({ error: 'Этот файл уже обработан' });


    const { name, faculty_id, course, language, mcq, open } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Название предмета не может быть пустым' });

    const subjectResult = await pool.query(
      'INSERT INTO subjects (name, faculty_id, course, language) VALUES ($1, $2, $3, $4) RETURNING id',
      [name.trim(), faculty_id || null, course || 1, language || 'ru']
    );
    const subjectId = subjectResult.rows[0].id;

    for (const q of (mcq || [])) {
      const qResult = await pool.query(
        'INSERT INTO questions (subject_id, type, question) VALUES ($1, $2, $3) RETURNING id',
        [subjectId, 'mcq', q.question]
      );
      const questionId = qResult.rows[0].id;
      for (const a of q.answers) {
        await pool.query(
          'INSERT INTO answers (question_id, text, is_correct) VALUES ($1, $2, $3)',
          [questionId, a.text, !!a.correct]
        );
      }
    }

    for (const q of (open || [])) {
      await pool.query(
        'INSERT INTO questions (subject_id, type, question) VALUES ($1, $2, $3)',
        [subjectId, 'open', q.question]
      );
    }

    await pool.query(
      'UPDATE hidden_chat_messages SET review_status = $1, approved_subject_id = $2 WHERE id = $3',
      ['approved', subjectId, req.params.id]
    );

    res.json({ success: true, subject_id: subjectId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/messages/:id/reject', authMiddleware, adminOnly, async (req, res) => {
  try {
    const msgResult = await pool.query('SELECT * FROM hidden_chat_messages WHERE id = $1', [req.params.id]);
    if (msgResult.rows.length === 0) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (msgResult.rows[0].review_status) return res.status(400).json({ error: 'Этот файл уже обработан' });

    await pool.query('UPDATE hidden_chat_messages SET review_status = $1 WHERE id = $2', ['rejected', req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



module.exports = router;