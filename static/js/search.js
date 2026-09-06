const toastEl = document.getElementById('toast');
let toastTimer;
/** Show a temporary toast message. */
function showToast(msg, type = 'error') {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = `toast toast--${type} show`;
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

const FILTER_LABELS = {
  all: 'All comments',
  positive: 'Positive only',
  neutral: 'Neutral only',
  negative: 'Negative only',
  questions: 'Viewer questions',
  technical: 'Technical issues',
};

let videoId      = sessionStorage.getItem('video_id') || null;
let totalLoaded  = parseInt(sessionStorage.getItem('comment_count') || '0', 10);
let activeFilter = 'all';
let lastQuery    = '';
let lastComments = [];

const searchInput  = document.getElementById('searchInput');
const searchBtn    = document.getElementById('searchBtn');
const filterTabs   = document.querySelectorAll('.filter-tab');
const commentList  = document.getElementById('commentList');
const resultsMeta  = document.getElementById('resultsMeta');
const resultsCount = document.getElementById('resultsCount');
const resultsHint  = document.getElementById('resultsHint');
const loadingMsg   = document.getElementById('loadingMsg');
const emptyMsg     = document.getElementById('emptyMsg');
const idleMsg      = document.getElementById('idleMsg');
const noVideoMsg   = document.getElementById('noVideoMsg');
const downloadPdf  = document.getElementById('exportMenu');
const analyzeBtn   = document.getElementById('analyzeBtn');
const historyList  = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const clearHistory = document.getElementById('clearHistory');
const minLikes     = document.getElementById('minLikes');
const dateFrom     = document.getElementById('dateFrom');
const dateTo       = document.getElementById('dateTo');
const applyFilters = document.getElementById('applyFilters');
const resetFilters = document.getElementById('resetFilters');

(async function init() {
  try {
    const r = await fetch('/api/check-video');
    const d = await r.json();
    if (d.video_id) {
      videoId = d.video_id;
      totalLoaded = d.count || totalLoaded;
      sessionStorage.setItem('video_id', videoId);
      sessionStorage.setItem('comment_count', totalLoaded);
    } else {
      videoId = null;
      sessionStorage.removeItem('video_id');
    }
  } catch (_) {}

  if (!videoId) {
    noVideoMsg.classList.remove('hidden');
    idleMsg.classList.add('hidden');
  } else {
    noVideoMsg.classList.add('hidden');
    idleMsg.classList.remove('hidden');
    await browseAll();
  }

  renderHistory();
})();

/** Build the current filter payload from UI controls. */
function buildFilters() {
  const f = {};
  if (activeFilter !== 'all') f.sentiment = activeFilter;
  const ml = parseInt(minLikes.value, 10);
  if (!isNaN(ml) && ml > 0) f.min_likes = ml;
  if (dateFrom.value) f.date_from = dateFrom.value;
  if (dateTo.value) f.date_to = dateTo.value;
  return f;
}

/** Whether the search box has a non-empty query. */
function hasSearchQuery() {
  return searchInput.value.trim().length > 0;
}

/** Load all comments for the current video with active filters. */
async function browseAll() {
  if (!videoId) return;
  lastQuery = '';
  const filters = buildFilters();
  setLoading(true);
  try {
    const res = await fetch('/api/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId, filters }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Could not load comments.');
    totalLoaded = data.total_loaded || data.count;
    lastComments = data.comments;
    renderResults(data.comments, { mode: 'browse' });
  } catch (err) {
    showToast(err.message);
    setLoading(false);
  }
}

/** Run a semantic search, or fall back to browse when the query is empty. */
async function runSearch() {
  if (!videoId) return;

  const query = searchInput.value.trim();
  if (!query) {
    await browseAll();
    return;
  }

  const filters = buildFilters();
  setLoading(true);

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId, query, filters }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Search failed.');

    totalLoaded = data.total_loaded || totalLoaded;
    lastComments = data.comments;
    lastQuery = query;
    saveToHistory(query);
    renderResults(data.comments, { mode: 'search', query });
  } catch (err) {
    showToast(err.message);
    setLoading(false);
  }
}

/** Re-run search or browse based on the current query. */
function refreshResults() {
  if (hasSearchQuery()) runSearch();
  else browseAll();
}

/** Render the comment list and results meta for browse or search mode. */
function renderResults(comments, { mode, query } = { mode: 'browse' }) {
  setLoading(false);
  commentList.innerHTML = '';

  if (!comments.length) {
    emptyMsg.classList.remove('hidden');
    resultsMeta.classList.add('hidden');
    return;
  }

  emptyMsg.classList.add('hidden');
  idleMsg.classList.add('hidden');
  resultsMeta.classList.remove('hidden');

  const filterLabel = FILTER_LABELS[activeFilter] || 'All comments';
  const n = comments.length;

  if (mode === 'search') {
    resultsCount.textContent = `${n} match${n !== 1 ? 'es' : ''} for "${query}"`;
    resultsHint.textContent = '';
  } else {
    resultsCount.textContent = activeFilter === 'all'
      ? `${n} comment${n !== 1 ? 's' : ''}`
      : `${n} comment${n !== 1 ? 's' : ''} · ${filterLabel}`;
    resultsHint.textContent = '';
  }

  if (downloadPdf) downloadPdf.style.display = '';

  comments.forEach(c => {
    const card = document.createElement('article');
    card.className = 'comment-card';
    const date = c.published_at ? c.published_at.slice(0, 10) : '';
    const sim = (mode === 'search' && c.similarity != null)
      ? `<span class="comment-card__similarity">${Math.round(c.similarity * 100)}% match</span>`
      : '';
    card.innerHTML = `
      <div class="comment-card__meta">
        <span class="comment-card__author">${escHtml(c.author)}</span>
        <span class="badge badge--${c.sentiment_label}">${c.sentiment_label}</span>
        <span class="comment-card__date">${date}</span>
        <span class="comment-card__likes">${c.likes} likes</span>
      </div>
      <p class="comment-card__text">${escHtml(c.text)}</p>
      ${sim}
    `;
    commentList.appendChild(card);
  });
}

/** Toggle the loading state and hide competing empty/meta messages. */
function setLoading(on) {
  loadingMsg.classList.toggle('hidden', !on);
  if (on) {
    emptyMsg.classList.add('hidden');
    resultsMeta.classList.add('hidden');
    idleMsg.classList.add('hidden');
    noVideoMsg.classList.add('hidden');
  }
}

filterTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    filterTabs.forEach(t => {
      t.classList.remove('active');
      t.setAttribute('aria-selected', 'false');
    });
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    activeFilter = tab.dataset.filter;
    refreshResults();
  });
});

applyFilters.addEventListener('click', refreshResults);
resetFilters.addEventListener('click', () => {
  minLikes.value = '';
  dateFrom.value = '';
  dateTo.value = '';
  refreshResults();
});
searchBtn.addEventListener('click', runSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

const HISTORY_KEY = 'cit_search_history';

/** Read recent search queries from localStorage. */
function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}

/** Persist a query at the front of recent search history (max 10). */
function saveToHistory(query) {
  if (!query) return;
  let h = getHistory().filter(q => q !== query);
  h.unshift(query);
  h = h.slice(0, 10);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  renderHistory();
}

/** Render the clickable recent-search list. */
function renderHistory() {
  const h = getHistory();
  historyList.innerHTML = '';
  if (!h.length) {
    historyEmpty.classList.remove('hidden');
    return;
  }
  historyEmpty.classList.add('hidden');
  h.forEach(q => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = q;
    btn.addEventListener('click', () => {
      searchInput.value = q;
      runSearch();
    });
    li.appendChild(btn);
    historyList.appendChild(li);
  });
}

clearHistory.addEventListener('click', () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

setupExportMenu({
  root: downloadPdf,
  getRows: () => lastComments.map(c => ({
    author: c.author,
    text: c.text,
    likes: c.likes,
    sentiment_label: c.sentiment_label,
    published_at: c.published_at,
  })),
  getTitle: () => {
    const filterLabel = FILTER_LABELS[activeFilter] || 'All comments';
    return lastQuery ? `Search: ${lastQuery}` : `Comments - ${filterLabel}`;
  },
  getFilenameBase: () => lastQuery ? 'search-results' : 'filtered-comments',
  getVideoId: () => videoId,
  onError: showToast,
});

analyzeBtn.addEventListener('click', () => {
  if (!lastComments.length) {
    showToast('Nothing to analyze.');
    return;
  }
  sessionStorage.setItem('analytics_scope', JSON.stringify({
    query: searchInput.value.trim(),
    filters: buildFilters(),
    source: 'search',
  }));
  window.location.href = '/analytics';
});

/** Escape HTML special characters for safe innerHTML insertion. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
