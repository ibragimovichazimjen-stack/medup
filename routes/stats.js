const express = require('express');
const pool = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const subjects = await pool.query('SELECT COUNT(*) FROM subjects');
    const questions = await pool.query("SELECT COUNT(*) FROM questions WHERE type = 'mcq'");
    const students = await pool.query('SELECT COUNT(*) FROM users');
    res.json({
      subjects: parseInt(subjects.rows[0].count),
      questions: parseInt(questions.rows[0].count),
      students: parseInt(students.rows[0].count)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;