const OFFLINE_DB_NAME = 'medup_offline';
const OFFLINE_DB_VERSION = 2;
const OFFLINE_STORE = 'subjects';
const SYNC_STORE = 'pending_results';

// Одна-единственная функция открытия базы, одна версия — раньше существовали
// openOfflineDB() (версия 1) и openOfflineDBv2() (версия 2) параллельно, и если
// в какой-то другой вкладке оставалось открытое соединение на старой версии,
// запрос новой версии молча зависал навсегда без единой ошибки в консоли.
function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
        db.createObjectStore(OFFLINE_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SYNC_STORE)) {
        db.createObjectStore(SYNC_STORE, { keyPath: 'localId', autoIncrement: true });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
    request.onblocked = () => reject(new Error('База данных заблокирована другой открытой вкладкой — закрой остальные вкладки сайта и обнови страницу'));
  });
}

// Скачивает предмет целиком (метаданные + все MCQ/открытые вопросы) в IndexedDB.
async function downloadSubjectOffline(subject) {
  const res = await fetch(`/tests/questions?subject_id=${subject.id}`);
  const questions = await res.json();

  const record = {
    id: subject.id,
    name: subject.name,
    faculty_name: subject.faculty_name,
    course: subject.course,
    language: subject.language,
    mcq_count: subject.mcq_count,
    open_count: subject.open_count,
    downloaded_at: new Date().toISOString(),
    questions
  };

  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, 'readwrite');
    tx.objectStore(OFFLINE_STORE).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

async function getOfflineSubject(subjectId) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, 'readonly');
    const request = tx.objectStore(OFFLINE_STORE).get(subjectId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function getAllOfflineSubjects() {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, 'readonly');
    const request = tx.objectStore(OFFLINE_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deleteOfflineSubject(subjectId) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, 'readwrite');
    tx.objectStore(OFFLINE_STORE).delete(subjectId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getDownloadedSubjectIds() {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_STORE, 'readonly');
    const request = tx.objectStore(OFFLINE_STORE).getAllKeys();
    request.onsuccess = () => resolve(new Set(request.result));
    request.onerror = () => reject(request.error);
  });
}

// Складываем непроверенный результат в очередь — отправится на сервер,
// как только появится связь
async function queuePendingResult(payload) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE, 'readwrite');
    tx.objectStore(SYNC_STORE).add(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllPendingResults() {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE, 'readonly');
    const request = tx.objectStore(SYNC_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function clearPendingResult(localId) {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE, 'readwrite');
    tx.objectStore(SYNC_STORE).delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getPendingCount() {
  const results = await getAllPendingResults();
  return results.length;
}

async function trySyncPendingResults(authHeadersFn) {
  if (!navigator.onLine) return { synced: 0, remaining: await getPendingCount() };

  const pending = await getAllPendingResults();
  let synced = 0;

  for (const item of pending) {
    try {
      await fetch('/results', {
        method: 'POST', headers: authHeadersFn(),
        body: JSON.stringify({ subject_id: item.subject_id, score: item.score, total: item.total })
      });
      await fetch('/results/question-stats', {
        method: 'POST', headers: authHeadersFn(),
        body: JSON.stringify({ answers: item.answers })
      });
      await clearPendingResult(item.localId);
      synced++;
    } catch (err) {
      break;
    }
  }

  return { synced, remaining: await getPendingCount() };
}