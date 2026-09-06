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

let videoId = sessionStorage.getItem('video_id') || null;
let lastTopics = [];
let activeFilter = 'all';

const searchInput = document.getElementById('searchInput');
const applyTopicsBtn = document.getElementById('applyTopicsBtn');
const filterTabs = document.querySelectorAll('.filter-tab');
const minLikes = document.getElementById('minLikes');
const dateFrom = document.getElementById('dateFrom');
const dateTo = document.getElementById('dateTo');
const applyFilters = document.getElementById('applyFilters');
const resetFilters = document.getElementById('resetFilters');
const clusterCount = document.getElementById('clusterCount');
const exportMenu = document.getElementById('exportMenu');
const topicList = document.getElementById('topicList');
const resultsMeta = document.getElementById('resultsMeta');
const resultsCount = document.getElementById('resultsCount');
const loadingMsg = document.getElementById('loadingMsg');
const emptyMsg = document.getElementById('emptyMsg');
const noVideoMsg = document.getElementById('noVideoMsg');

(async function init() {
  try {
    const r = await fetch('/api/check-video');
    const d = await r.json();
    if (d.video_id) {
      videoId = d.video_id;
      sessionStorage.setItem('video_id', videoId);
      if (d.count) sessionStorage.setItem('comment_count', d.count);
    } else {
      videoId = null;
      sessionStorage.removeItem('video_id');
    }
  } catch (_) {}

  if (!videoId) {
    noVideoMsg.classList.remove('hidden');
    if (exportMenu) exportMenu.querySelector('[data-export-toggle]').disabled = true;
    applyTopicsBtn.disabled = true;
    return;
  }

  noVideoMsg.classList.add('hidden');
  await loadTopics();
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

/** Fetch topic clusters for the current video and filters. */
async function loadTopics() {
  if (!videoId) return;
  setLoading(true);
  try {
    const res = await fetch('/api/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: videoId,
        n_clusters: parseInt(clusterCount.value, 10) || 5,
        query: searchInput.value.trim(),
        filters: buildFilters(),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'Could not build topics.');
    lastTopics = data.topics || [];
    renderTopics(lastTopics);
  } catch (err) {
    showToast(err.message);
    setLoading(false);
    emptyMsg.classList.remove('hidden');
    resultsMeta.classList.add('hidden');
    topicList.innerHTML = '';
  }
}

/** Toggle the loading state and clear the topic list when loading. */
function setLoading(on) {
  loadingMsg.classList.toggle('hidden', !on);
  if (on) {
    emptyMsg.classList.add('hidden');
    resultsMeta.classList.add('hidden');
    topicList.innerHTML = '';
    noVideoMsg.classList.add('hidden');
  }
}

/** Render topic cards with core messages and expandable comment lists. */
function renderTopics(topics) {
  setLoading(false);
  topicList.innerHTML = '';

  if (!topics.length) {
    emptyMsg.classList.remove('hidden');
    resultsMeta.classList.add('hidden');
    return;
  }

  emptyMsg.classList.add('hidden');
  resultsMeta.classList.remove('hidden');

  const totalComments = topics.reduce((sum, t) => sum + (t.count || 0), 0);
  const query = searchInput.value.trim();
  const filterLabel = FILTER_LABELS[activeFilter] || 'All comments';
  let label = `${topics.length} topic${topics.length !== 1 ? 's' : ''} · ${totalComments} comments`;
  if (query) label += ` for "${query}"`;
  else if (activeFilter !== 'all') label += ` · ${filterLabel}`;
  resultsCount.textContent = label;

  topics.forEach((topic, index) => {
    const card = document.createElement('article');
    card.className = 'topic-card';

    const core = topic.core_message || {};
    const coreId = core.comment_id;
    const others = (topic.comments || []).filter(c => c.comment_id !== coreId);
    const previewLimit = 4;
    const hasMore = others.length > previewLimit;

    card.innerHTML = `
      <div class="topic-card__header">
        <h2 class="topic-card__title">${escHtml(topic.title || 'general discussion')}</h2>
        <span class="topic-card__count">${topic.count} comment${topic.count !== 1 ? 's' : ''}</span>
      </div>
      <div class="core-message">
        <span class="core-message__label">Core message</span>
        <div class="core-message__meta">
          <span class="core-message__author">${escHtml(core.author || '')}</span>
          <span class="badge badge--${core.sentiment_label || 'neutral'}">${escHtml(core.sentiment_label || '')}</span>
          <span class="core-message__date">${(core.published_at || '').slice(0, 10)}</span>
          <span class="core-message__likes">${core.likes || 0} likes</span>
        </div>
        <p class="core-message__text">${escHtml(core.text || '')}</p>
      </div>
      <div class="topic-card__comments" data-topic-index="${index}">
        <p class="topic-card__comments-label">Other comments in this topic</p>
        ${others.slice(0, previewLimit).map(commentHtml).join('')}
        ${hasMore ? `<div class="topic-card__extra hidden">${others.slice(previewLimit).map(commentHtml).join('')}</div>` : ''}
      </div>
      ${hasMore ? `<button class="btn btn--ghost btn--sm topic-card__toggle" type="button" data-topic-index="${index}" data-total="${others.length}">Show all ${others.length}</button>` : ''}
    `;

    topicList.appendChild(card);
  });

  topicList.querySelectorAll('.topic-card__toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.topicIndex;
      const total = btn.dataset.total;
      const block = topicList.querySelector(`.topic-card__comments[data-topic-index="${idx}"] .topic-card__extra`);
      if (!block) return;
      const open = block.classList.toggle('hidden') === false;
      btn.textContent = open ? 'Show less' : `Show all ${total}`;
    });
  });
}

/** Build HTML for a single comment card inside a topic. */
function commentHtml(c) {
  return `
    <article class="comment-card">
      <div class="comment-card__meta">
        <span class="comment-card__author">${escHtml(c.author || '')}</span>
        <span class="badge badge--${c.sentiment_label || 'neutral'}">${escHtml(c.sentiment_label || '')}</span>
        <span class="comment-card__date">${(c.published_at || '').slice(0, 10)}</span>
        <span class="comment-card__likes">${c.likes || 0} likes</span>
      </div>
      <p class="comment-card__text">${escHtml(c.text || '')}</p>
    </article>
  `;
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
    loadTopics();
  });
});

applyTopicsBtn.addEventListener('click', loadTopics);
applyFilters.addEventListener('click', loadTopics);
clusterCount.addEventListener('change', loadTopics);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') loadTopics(); });

resetFilters.addEventListener('click', () => {
  minLikes.value = '';
  dateFrom.value = '';
  dateTo.value = '';
  clusterCount.value = '5';
  loadTopics();
});

/** Flatten topics into comment-like rows for CSV/PDF export. */
function topicsToRows(topics) {
  const flat = [];
  topics.forEach(topic => {
    flat.push({
      author: `TOPIC: ${topic.title}`,
      text: `Core message: ${(topic.core_message && topic.core_message.text) || ''}`,
      likes: topic.count,
      sentiment_label: '',
      published_at: '',
    });
    (topic.comments || []).forEach(c => {
      flat.push({
        author: c.author,
        text: c.text,
        likes: c.likes,
        sentiment_label: c.sentiment_label,
        published_at: c.published_at,
      });
    });
  });
  return flat;
}

setupExportMenu({
  root: exportMenu,
  getRows: () => topicsToRows(lastTopics),
  getTitle: () => {
    const q = searchInput.value.trim();
    return q ? `Topics - ${q}` : 'Topics export';
  },
  getFilenameBase: () => 'topics',
  getVideoId: () => videoId,
  onError: showToast,
});

document.getElementById('analyzeBtn').addEventListener('click', () => {
  if (!lastTopics.length) {
    showToast('Nothing to analyze.');
    return;
  }
  sessionStorage.setItem('topic_analytics_scope', JSON.stringify({
    query: searchInput.value.trim(),
    filters: buildFilters(),
    n_clusters: parseInt(clusterCount.value, 10) || 5,
  }));
  window.location.href = '/topic-analytics';
});

/** Escape HTML special characters for safe innerHTML insertion. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
