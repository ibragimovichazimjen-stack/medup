// ============================================================
// Раздел "Разбор" (exam.html?mode=analysis) — темы, группировка карточек
// и анимация переноса карточки при назначении темы.
// ============================================================

let allTopics = [];
let activeTopicId = null;
let analysisCards = [];
let lastToggledQuestionId = null;

const TOPIC_COLORS = ['#3B7DD8', '#22C9A5', '#E8A33D', '#C0392B', '#8E5FD9', '#2ECC9A', '#D4739A', '#5A9C4F', '#4A8FE8', '#B7791F'];

function topicColor(topicId) {
  const idx = allTopics.findIndex(t => t.id === topicId);
  return idx === -1 ? '#8899AA' : TOPIC_COLORS[idx % TOPIC_COLORS.length];
}

async function runAnalysis() {
  if (isOfflineRun || !navigator.onLine) {
    document.body.innerHTML = '<p style="padding:60px 20px; text-align:center;">Разбор по вопросам требует подключения к интернету.</p>';
    return;
  }

  try {
    const [cardsRes, topicsRes] = await Promise.all([
      fetch(`/results/question-cards/${selectedSubjectId}`, { headers: authHeaders() }),
      fetch(`/tests/subjects/${selectedSubjectId}/topics`, { headers: authHeaders() })
    ]);
    if (!cardsRes.ok || !topicsRes.ok) throw new Error('Сервер ответил ошибкой');
    analysisCards = await cardsRes.json();
    allTopics = await topicsRes.json();
  } catch (err) {
    document.body.innerHTML = '<p style="padding:60px 20px; text-align:center;">Не удалось загрузить разбор — проверь соединение.</p>';
    return;
  }

  document.getElementById('analysisSection').style.display = 'block';

  if (isAdmin) {
    document.getElementById('topicSidebar').style.display = 'block';
    renderTopicSidebar();
    renderAdminCardGrid();
  } else {
    renderStudentGroupedView();
  }
}

function renderTopicSidebar() {
  const container = document.getElementById('topicList');
  if (allTopics.length === 0) {
    container.innerHTML = '<p class="topic-empty-hint">Тем пока нет</p>';
    return;
  }
  container.innerHTML = allTopics.map(t => `
    <div class="topic-pill ${activeTopicId === t.id ? 'active' : ''}" onclick="selectActiveTopic(${t.id})">
      <span class="topic-dot" style="background:${topicColor(t.id)}"></span>
      <span class="topic-pill-name">${t.name}</span>
      <span class="topic-pill-count">${t.question_count}</span>
      <button class="topic-delete-btn" onclick="event.stopPropagation(); deleteTopic(${t.id})">✕</button>
    </div>`).join('');
}

function selectActiveTopic(id) {
  activeTopicId = (activeTopicId === id) ? null : id;
  renderTopicSidebar();
}

function openAddTopicForm() { document.getElementById('addTopicForm').style.display = 'block'; }
function closeAddTopicForm() {
  document.getElementById('addTopicForm').style.display = 'none';
  document.getElementById('newTopicName').value = '';
}

async function createTopic() {
  const name = document.getElementById('newTopicName').value.trim();
  if (!name) { alert('Введи название темы'); return; }
  const res = await fetch(`/tests/subjects/${selectedSubjectId}/topics`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ name })
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  closeAddTopicForm();
  allTopics.push({ id: data.id, name: data.name, question_count: 0 });
  renderTopicSidebar();
}

async function deleteTopic(id) {
  if (!confirm('Удалить эту тему? Вопросы останутся, но потеряют привязку к теме.')) return;
  await fetch(`/tests/topics/${id}`, { method: 'DELETE', headers: authHeaders() });
  allTopics = allTopics.filter(t => t.id !== id);
  analysisCards.forEach(c => { if (c.topic_id === id) { c.topic_id = null; c.topic_name = null; } });
  if (activeTopicId === id) activeTopicId = null;
  renderTopicSidebar();
  renderAdminCardGrid();
}

// Порядок карточек: сначала темы в порядке их создания (единой группой
// каждая), затем нераспределённые вопросы в конце — именно этот порядок
// и определяет, какие карточки "взлетают" при назначении темы.
function sortedAnalysisCards() {
  const byTopic = {};
  const untouched = [];
  analysisCards.forEach(c => {
    if (c.topic_id) {
      if (!byTopic[c.topic_id]) byTopic[c.topic_id] = [];
      byTopic[c.topic_id].push(c);
    } else {
      untouched.push(c);
    }
  });
  let ordered = [];
  allTopics.forEach(t => { if (byTopic[t.id]) ordered = ordered.concat(byTopic[t.id]); });
  return ordered.concat(untouched);
}

function renderAdminCardGrid() {
  const container = document.getElementById('analysisGrid');

  const oldRects = {};
  container.querySelectorAll('.qcard').forEach(el => {
    oldRects[el.dataset.qid] = el.getBoundingClientRect();
  });

  const ordered = sortedAnalysisCards();

  container.innerHTML = '<div class="qcard-grid">' + ordered.map(c => {
    const color = c.topic_id ? topicColor(c.topic_id) : null;
    const style = color ? `border-left: 4px solid ${color};` : '';
    return `
      <div class="qcard admin-taggable" data-qid="${c.question_id}" style="${style}" onclick="toggleCardTopic(${c.question_id})">
        <div class="qcard-number">№${c.number}${c.topic_name ? ` · <span style="color:${color}">${c.topic_name}</span>` : ''}</div>
        <div class="qcard-text">${c.question}</div>
        <div class="qcard-stats">
          <span class="qcard-stat ok">верно ${c.correct}</span>
          <span class="qcard-stat fail">неверно ${c.wrong}</span>
        </div>
      </div>`;
  }).join('') + '</div>';

  container.querySelectorAll('.qcard').forEach(el => {
    const qid = el.dataset.qid;
    const oldRect = oldRects[qid];
    if (!oldRect) return;

    const newRect = el.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    const isTheOneJustClicked = String(lastToggledQuestionId) === qid;

    if (dx === 0 && dy === 0 && !isTheOneJustClicked) return;

    const extra = isTheOneJustClicked ? 'rotate(-6deg) scale(1.05)' : '';
    el.classList.toggle('qcard-flip-active', isTheOneJustClicked);
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px) ${extra}`;

    requestAnimationFrame(() => {
      el.style.transition = isTheOneJustClicked
        ? 'transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)'
        : 'transform 0.35s ease';
      el.style.transform = '';
      if (isTheOneJustClicked) setTimeout(() => el.classList.remove('qcard-flip-active'), 500);
    });
  });
}

async function toggleCardTopic(questionId) {
  // Без активной темы — обычный клик по карточке пока ничего не делает.
  // Позже здесь появится отдельное взаимодействие с самим вопросом.
  if (activeTopicId === null) return;

  const card = analysisCards.find(c => c.question_id === questionId);
  const newTopicId = (card.topic_id === activeTopicId) ? null : activeTopicId;

  const res = await fetch('/tests/question-topic', {
    method: 'PUT', headers: authHeaders(),
    body: JSON.stringify({ question_ids: [questionId], topic_id: newTopicId })
  });

  if (!res.ok) { alert('Не удалось сохранить — попробуй ещё раз'); return; }

  const oldTopicId = card.topic_id;
  card.topic_id = newTopicId;
  card.topic_name = newTopicId ? allTopics.find(t => t.id === newTopicId).name : null;

  if (oldTopicId) { const t = allTopics.find(t => t.id === oldTopicId); if (t) t.question_count--; }
  if (newTopicId) { const t = allTopics.find(t => t.id === newTopicId); if (t) t.question_count++; }

  lastToggledQuestionId = questionId;
  renderTopicSidebar();
  renderAdminCardGrid();
}

function renderStudentGroupedView() {
  if (allTopics.length === 0) {
    document.getElementById('analysisGrid').innerHTML = analysisCards.length === 0
      ? '<p style="color:var(--text-secondary); font-size:14px;">В этом предмете пока нет вопросов</p>'
      : `<div class="qcard-grid">${analysisCards.map(renderCardHtml).join('')}</div>`;
    return;
  }

  const grouped = {};
  const untouched = [];
  analysisCards.forEach(c => {
    if (c.topic_id) { if (!grouped[c.topic_id]) grouped[c.topic_id] = []; grouped[c.topic_id].push(c); }
    else untouched.push(c);
  });

  let html = '';
  allTopics.forEach(t => {
    const cards = grouped[t.id] || [];
    if (cards.length === 0) return;
    html += `<div class="analysis-topic-section">
      <div class="analysis-topic-heading">${t.name}</div>
      <div class="qcard-grid">${cards.map(renderCardHtml).join('')}</div>
    </div>`;
  });

  if (untouched.length > 0) {
    html += `<div class="analysis-topic-section">
      <div class="analysis-topic-heading analysis-topic-untitled">Без темы</div>
      <div class="qcard-grid">${untouched.map(renderCardHtml).join('')}</div>
    </div>`;
  }

  document.getElementById('analysisGrid').innerHTML = html || '<p style="color:var(--text-secondary); font-size:14px;">В этом предмете пока нет вопросов</p>';
}

function renderCardHtml(c) {
  const tierClass = 'pp-' + (c.pp_tier || 'gray');
  const ppLabel = c.pp === null
    ? 'Реши ещё раз — рано оценивать'
    : `Готовность: ${Math.round(c.pp)}%`;
  return `
    <div class="qcard ${tierClass}">
      <div class="qcard-number">№${c.number}</div>
      <div class="qcard-text">${c.question}</div>
      <div class="qcard-stats">
        <span class="qcard-stat ok">верно ${c.correct}</span>
        <span class="qcard-stat fail">неверно ${c.wrong}</span>
      </div>
      <div class="qcard-pp-label">${ppLabel}</div>
    </div>`;
}