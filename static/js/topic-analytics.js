const toastEl = document.getElementById('toast');
let toastTimer;
/** Show a temporary toast message. */
function showToast(msg, type = 'error') {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = `toast toast--${type} show`;
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

const SCOPE_KEY = 'topic_analytics_scope';
const SENTIMENT_KEYS = ['positive', 'neutral', 'negative'];

let videoId = sessionStorage.getItem('video_id') || null;
let exportRows = [];
let sizeChart = null;
let sentimentChart = null;
let likesChart = null;
let allTopics = [];
let summaryMeta = { total_comments: 0, total_likes: 0, unique_authors: 0 };
let selectedClusterId = null;
let activeFilter = 'all';
let firstLoad = true;

const noVideoMsg = document.getElementById('noVideoMsg');
const loadingMsg = document.getElementById('loadingMsg');
const analyticsContent = document.getElementById('analyticsContent');
const exportMenu = document.getElementById('exportMenu');
const scopeBanner = document.getElementById('scopeBanner');
const topicStatsList = document.getElementById('topicStatsList');
const searchInput = document.getElementById('searchInput');
const minLikes = document.getElementById('minLikes');
const dateFrom = document.getElementById('dateFrom');
const dateTo = document.getElementById('dateTo');
const clusterCount = document.getElementById('clusterCount');
const applyFiltersBtn = document.getElementById('applyFiltersBtn');
const resetFiltersBtn = document.getElementById('resetFiltersBtn');
const clearTopicFilterBtn = document.getElementById('clearTopicFilterBtn');
const selectionBar = document.getElementById('selectionBar');
const selectionChips = document.getElementById('selectionChips');
const filterTabs = document.querySelectorAll('.filter-tab');

const chartDefaults = {
  color: '#888888',
  borderColor: '#2e2e2e',
  font: { family: 'Inter, system-ui, sans-serif' },
};

/** Restore topic-analytics filters from sessionStorage into the form. */
function readScope() {
  try {
    const raw = sessionStorage.getItem(SCOPE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    searchInput.value = (data.query || '').trim();
    const f = data.filters || {};
    activeFilter = f.sentiment || 'all';
    if (f.min_likes != null) minLikes.value = f.min_likes;
    if (f.date_from) dateFrom.value = f.date_from;
    if (f.date_to) dateTo.value = String(f.date_to).slice(0, 10);
    if (data.n_clusters) clusterCount.value = String(data.n_clusters);
  } catch (_) {}
}

/** Sync filter-tab active state with `activeFilter`. */
function syncFilterTabs() {
  filterTabs.forEach(tab => {
    const on = tab.dataset.filter === activeFilter;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

/** Build the API filter object from form controls. */
function buildFilters() {
  const f = {};
  if (activeFilter !== 'all') f.sentiment = activeFilter;
  const ml = parseInt(minLikes.value, 10);
  if (!isNaN(ml) && ml > 0) f.min_likes = ml;
  if (dateFrom.value) f.date_from = dateFrom.value;
  if (dateTo.value) f.date_to = dateTo.value;
  return f;
}

/** Persist query, filters, and cluster count to sessionStorage. */
function persistScope() {
  sessionStorage.setItem(SCOPE_KEY, JSON.stringify({
    query: searchInput.value.trim(),
    filters: buildFilters(),
    n_clusters: parseInt(clusterCount.value, 10) || 5,
  }));
}

/** Topics currently shown (all, or the selected cluster only). */
function visibleTopics() {
  if (selectedClusterId == null) return allTopics;
  return allTopics.filter(t => t.cluster_id === selectedClusterId);
}

/** Update the scope banner and selected-topic chip. */
function updateSelectionUi() {
  const parts = [];
  const q = searchInput.value.trim();
  if (q) parts.push(`search "${q}"`);
  if (activeFilter !== 'all') parts.push(activeFilter);
  const ml = parseInt(minLikes.value, 10);
  if (!isNaN(ml) && ml > 0) parts.push(`min ${ml} likes`);
  if (dateFrom.value || dateTo.value) {
    parts.push(`dates ${dateFrom.value || '…'} to ${dateTo.value || '…'}`);
  }
  parts.push(`${clusterCount.value} groups`);

  scopeBanner.textContent = parts.length
    ? `Comparing topics for: ${parts.join(' · ')}`
    : 'Comparing topics across all comments.';
  scopeBanner.classList.remove('hidden');

  selectionChips.innerHTML = '';
  if (selectedClusterId == null) {
    selectionBar.classList.add('hidden');
    clearTopicFilterBtn.classList.add('hidden');
  } else {
    const topic = allTopics.find(t => t.cluster_id === selectedClusterId);
    const label = topic?.title || `topic ${selectedClusterId}`;
    selectionBar.classList.remove('hidden');
    clearTopicFilterBtn.classList.remove('hidden');
    const el = document.createElement('span');
    el.className = 'selection-chip';
    el.innerHTML = `${escHtml(label)} <button type="button" data-clear-topic aria-label="Clear topic">×</button>`;
    selectionChips.appendChild(el);
  }
}

/** Toggle focus on a topic cluster (or clear if already selected). */
function selectTopic(clusterId) {
  selectedClusterId = selectedClusterId === clusterId ? null : clusterId;
  updateSelectionUi();
  renderAll();
}

/** Refresh stats, export rows, charts, and topic cards for visible topics. */
function renderAll() {
  const topics = visibleTopics();
  const comments = topics.reduce((s, t) => s + (t.count || 0), 0);
  const likes = topics.reduce((s, t) => s + (t.total_likes || 0), 0);

  document.getElementById('statTopics').textContent = topics.length;
  document.getElementById('statComments').textContent =
    selectedClusterId == null ? summaryMeta.total_comments : comments;
  document.getElementById('statLikes').textContent =
    selectedClusterId == null ? summaryMeta.total_likes : likes;
  document.getElementById('statAuthors').textContent =
    selectedClusterId == null ? summaryMeta.unique_authors : '—';

  exportRows = topics.map(t => ({
    author: t.title,
    text: (t.core_message && t.core_message.text) || '',
    likes: t.total_likes,
    sentiment_label: `${t.positive_rate}% positive`,
    published_at: `${t.count} comments`,
  }));

  renderSizeChart(topics);
  renderSentimentChart(topics);
  renderLikesChart(topics);
  renderTopicCards(topics);
}

selectionChips.addEventListener('click', e => {
  if (e.target.closest('[data-clear-topic]')) {
    selectedClusterId = null;
    updateSelectionUi();
    renderAll();
  }
});

clearTopicFilterBtn.addEventListener('click', () => {
  selectedClusterId = null;
  updateSelectionUi();
  renderAll();
});

filterTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    activeFilter = tab.dataset.filter;
    syncFilterTabs();
    selectedClusterId = null;
    persistScope();
    updateSelectionUi();
    loadAnalytics();
  });
});

applyFiltersBtn.addEventListener('click', () => {
  selectedClusterId = null;
  persistScope();
  updateSelectionUi();
  loadAnalytics();
});

resetFiltersBtn.addEventListener('click', () => {
  searchInput.value = '';
  activeFilter = 'all';
  minLikes.value = '';
  dateFrom.value = '';
  dateTo.value = '';
  clusterCount.value = '5';
  selectedClusterId = null;
  syncFilterTabs();
  sessionStorage.removeItem(SCOPE_KEY);
  updateSelectionUi();
  loadAnalytics();
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') applyFiltersBtn.click();
});

(async function init() {
  readScope();
  syncFilterTabs();
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
    return;
  }

  noVideoMsg.classList.add('hidden');
  updateSelectionUi();
  await loadAnalytics();
})();

/** Fetch topic analytics from the API and render the dashboard. */
async function loadAnalytics() {
  setLoading(true);
  try {
    const res = await fetch('/api/topic-analytics', {
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
    if (!res.ok || data.error) throw new Error(data.error || 'Topic analytics failed.');

    allTopics = data.topics || [];
    summaryMeta = {
      total_comments: data.total_comments ?? 0,
      total_likes: data.total_likes ?? 0,
      unique_authors: data.unique_authors ?? 0,
    };
    selectedClusterId = null;
    updateSelectionUi();
    renderAll();

    setLoading(false);
    analyticsContent.classList.remove('hidden');
    firstLoad = false;
  } catch (err) {
    showToast(err.message);
    setLoading(false);
    if (firstLoad) analyticsContent.classList.add('hidden');
  }
}

/** Show a full-page loader on first load, or dim content on refresh. */
function setLoading(on) {
  if (firstLoad || analyticsContent.classList.contains('hidden')) {
    loadingMsg.classList.toggle('hidden', !on);
    if (on) analyticsContent.classList.add('hidden');
  } else {
    analyticsContent.classList.toggle('content-dim', on);
    loadingMsg.classList.add('hidden');
  }
}

/** Truncate a topic title for chart axis labels. */
function shortLabel(title, max = 22) {
  const t = title || 'topic';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Bar colors that highlight the selected cluster when one is focused. */
function barColors(topics, activeColor, idleColor) {
  return topics.map(t =>
    selectedClusterId == null || t.cluster_id === selectedClusterId ? activeColor : idleColor
  );
}

/** Handle a chart click by selecting the topic at the given index. */
function onTopicIndexClick(topics, index) {
  const topic = topics[index];
  if (!topic) return;
  selectTopic(topic.cluster_id);
}

/** Toggle a sentiment filter from the stacked chart legend. */
function applySentimentFilter(label) {
  const key = String(label).toLowerCase();
  if (!SENTIMENT_KEYS.includes(key)) return;
  if (activeFilter === key) {
    activeFilter = 'all';
  } else {
    activeFilter = key;
  }
  syncFilterTabs();
  selectedClusterId = null;
  persistScope();
  updateSelectionUi();
  loadAnalytics();
}

/** Draw or redraw the topic-size bar chart. */
function renderSizeChart(topics) {
  const ctx = document.getElementById('sizeChart');
  if (sizeChart) sizeChart.destroy();
  sizeChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: topics.map(t => shortLabel(t.title)),
      datasets: [{
        label: 'Comments',
        data: topics.map(t => t.count),
        backgroundColor: barColors(topics, '#c0392b', '#3a3a3a'),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_evt, elements) => {
        if (!elements.length) return;
        onTopicIndexClick(topics, elements[0].index);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => topics[items[0].dataIndex]?.title || '',
          },
        },
      },
      scales: {
        x: {
          ticks: { color: chartDefaults.color, maxRotation: 45, minRotation: 0 },
          grid: { color: chartDefaults.borderColor },
        },
        y: {
          beginAtZero: true,
          ticks: { color: chartDefaults.color, precision: 0 },
          grid: { color: chartDefaults.borderColor },
        },
      },
    },
  });
}

/** Draw or redraw the per-topic stacked sentiment chart. */
function renderSentimentChart(topics) {
  const ctx = document.getElementById('sentimentChart');
  if (sentimentChart) sentimentChart.destroy();
  sentimentChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: topics.map(t => shortLabel(t.title)),
      datasets: [
        {
          label: 'Positive',
          data: topics.map(t => t.sentiment?.positive || 0),
          backgroundColor: '#27ae60',
          borderRadius: 4,
        },
        {
          label: 'Neutral',
          data: topics.map(t => t.sentiment?.neutral || 0),
          backgroundColor: '#f39c12',
          borderRadius: 4,
        },
        {
          label: 'Negative',
          data: topics.map(t => t.sentiment?.negative || 0),
          backgroundColor: '#c0392b',
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_evt, elements) => {
        if (!elements.length) return;
        const el = elements[0];
        // Ctrl/meta or second click path: sentiment from dataset; default: select topic
        if (_evt.native && (_evt.native.altKey || _evt.native.shiftKey)) {
          const label = sentimentChart.data.datasets[el.datasetIndex]?.label;
          applySentimentFilter(label);
        } else {
          onTopicIndexClick(topics, el.index);
        }
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: chartDefaults.color, boxWidth: 12 },
          onClick: (_e, item) => applySentimentFilter(item.text),
        },
        tooltip: {
          callbacks: {
            title: items => topics[items[0].dataIndex]?.title || '',
            footer: () => 'Click bar: focus topic · Click legend: filter sentiment',
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: chartDefaults.color, maxRotation: 45, minRotation: 0 },
          grid: { color: chartDefaults.borderColor },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { color: chartDefaults.color, precision: 0 },
          grid: { color: chartDefaults.borderColor },
        },
      },
    },
  });
}

/** Draw or redraw the horizontal total-likes chart. */
function renderLikesChart(topics) {
  const ctx = document.getElementById('likesChart');
  if (likesChart) likesChart.destroy();
  likesChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: topics.map(t => shortLabel(t.title)),
      datasets: [{
        label: 'Likes',
        data: topics.map(t => t.total_likes),
        backgroundColor: barColors(topics, '#e74c3c', '#3a3a3a'),
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_evt, elements) => {
        if (!elements.length) return;
        onTopicIndexClick(topics, elements[0].index);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => topics[items[0].dataIndex]?.title || '',
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          ticks: { color: chartDefaults.color, precision: 0 },
          grid: { color: chartDefaults.borderColor },
        },
        y: {
          ticks: { color: chartDefaults.color },
          grid: { display: false },
        },
      },
    },
  });
}

/** Render clickable topic summary cards with sentiment bars. */
function renderTopicCards(topics) {
  topicStatsList.innerHTML = '';
  const source = selectedClusterId == null ? allTopics : topics;
  source.forEach(t => {
    const sent = t.sentiment || {};
    const total = Math.max(t.count || 1, 1);
    const pos = sent.positive || 0;
    const neu = sent.neutral || 0;
    const neg = sent.negative || 0;
    const core = t.core_message || {};

    const card = document.createElement('article');
    card.className = 'topic-stat-card';
    card.tabIndex = 0;
    if (selectedClusterId === t.cluster_id) card.classList.add('active');
    card.innerHTML = `
      <div class="topic-stat-card__header">
        <h3 class="topic-stat-card__title">${escHtml(t.title || 'general discussion')}</h3>
        <span class="topic-stat-card__count">${t.count} comment${t.count !== 1 ? 's' : ''}</span>
      </div>
      <div class="sentiment-bar" role="img" aria-label="Sentiment mix: ${pos} positive, ${neu} neutral, ${neg} negative">
        <span class="sentiment-bar__seg sentiment-bar__seg--positive" style="flex: ${pos / total}"></span>
        <span class="sentiment-bar__seg sentiment-bar__seg--neutral" style="flex: ${neu / total}"></span>
        <span class="sentiment-bar__seg sentiment-bar__seg--negative" style="flex: ${neg / total}"></span>
      </div>
      <div class="topic-stat-card__metrics">
        <span><strong>${t.positive_rate}%</strong> positive</span>
        <span><strong>${t.total_likes}</strong> likes</span>
        <span><strong>${t.avg_likes}</strong> avg likes</span>
        <span><strong>${pos}</strong> / <strong>${neu}</strong> / <strong>${neg}</strong> pos/neu/neg</span>
      </div>
      <div class="core-snippet">
        <span class="core-snippet__label">Core message</span>
        <p class="core-snippet__text">${escHtml(core.text || 'No core message.')}</p>
      </div>
    `;
    const activate = () => selectTopic(t.cluster_id);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    topicStatsList.appendChild(card);
  });
}

setupExportMenu({
  root: exportMenu,
  getRows: () => exportRows,
  getTitle: () => {
    const q = searchInput.value.trim();
    return q ? `Topic analytics - ${q}` : 'Topic analytics';
  },
  getFilenameBase: () => 'topic-analytics',
  getVideoId: () => videoId,
  onError: showToast,
});

/** Escape HTML special characters for safe innerHTML insertion. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
