function parseTxtFile(content) {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l);
  const mcq = [];
  const open = [];
  let current = null;
  let type = null;

  for (const line of lines) {
    if (line.startsWith('??')) {
      if (current) type === 'mcq' ? mcq.push(current) : open.push(current);
      type = 'open';
      current = { question: line.slice(2).trim() };
    } else if (line.startsWith('?')) {
      if (current) type === 'mcq' ? mcq.push(current) : open.push(current);
      type = 'mcq';
      current = { question: line.slice(1).trim(), answers: [] };
    } else if (line.startsWith('+') && type === 'mcq') {
      current.answers.push({ text: line.slice(1).trim(), correct: true });
    } else if (line.startsWith('-') && type === 'mcq') {
      current.answers.push({ text: line.slice(1).trim(), correct: false });
    }
  }

  if (current) type === 'mcq' ? mcq.push(current) : open.push(current);
  return { mcq, open };
}

module.exports = { parseTxtFile };