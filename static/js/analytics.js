const toastEl = document.getElementById('toast');
let toastTimer;
/** Show a temporary toast message. */
function showToast(msg, type = 'error') {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = `toast toast--${type} show`;
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

const SCOPE_KEY = 'analytics_scope';
const SENTIMENT_KEYS = ['positive', 'neutral', 'negative'];

let videoId = sessionStorage.getItem('video_id') || null;
let sentimentChart = null;
let datesChart = null;
let datesData = [];
let activeFilter = 'all';
let firstLoad = true;

const noVideoMsg = document.getElementById('noVideoMsg');
const loadingMsg = document.getElementById('loadingMsg');
const analyticsContent = document.getElementById('analyticsContent');
const heatmap = document.getElementById('heatmap');
const heatmapEmpty = document.getElementById('heatmapEmpty');
const commentsEl = document.getElementById('minuteComments');
const commentsTitle = document.getElementById('commentsTitle');
const commentsHint = document.getElementById('commentsHint');
const authorList = document.getElementById('authorList');
const scopeBanner = document.getElementById('scopeBanner');
const searchInput = document.getElementById('searchInput');
const minLikes = document.getElementById('minLikes');
const dateFrom = document.getElementById('dateFrom');
const dateTo = document.getElementById('dateTo');
const applyFiltersBtn = document.getElementById('applyFiltersBtn');
const resetFiltersBtn = document.getElementById('resetFiltersBtn');
const selectionBar = document.getElementById('selectionBar');
const selectionChips = document.getElementById('selectionChips');
const filterTabs = document.querySelectorAll('.filter-tab');

const chartDefaults = {
  color: '#888888',
  borderColor: '#2e2e2e',
  font: { family: 'Inter, system-ui, sans-serif' },
};

/** Restore analytics filters from sessionStorage into the form. */
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
    // chart-only filters restored via syncFormFromFilters after build
    window.__chartRestore = {
      minute: f.minute,
      author: f.author,
    };
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

/** Build the API filter object from form and chart selections. */
function buildFilters() {
  const f = {};
  if (activeFilter !== 'all') f.sentiment = activeFilter;
  const ml = parseInt(minLikes.value, 10);
  if (!isNaN(ml) && ml > 0) f.min_likes = ml;
  if (dateFrom.value) f.date_from = dateFrom.value;
  if (dateTo.value) f.date_to = dateTo.value;
  if (window.__chartMinute != null && window.__chartMinute !== '') {
    f.minute = window.__chartMinute;
  }
  if (window.__chartAuthor) f.author = window.__chartAuthor;
  return f;
}

/** Persist the current query and filters to sessionStorage. */
function persistScope() {
  sessionStorage.setItem(SCOPE_KEY, JSON.stringify({
    query: searchInput.value.trim(),
    filters: buildFilters(),
  }));
}

/** Request body shared by analytics, timestamps, and browse calls. */
function scopePayload() {
  return {
    video_id: videoId,
    query: searchInput.value.trim(),
    filters: buildFilters(),
  };
}

/** Update selection chips and the scope banner from current filters. */
function updateSelectionUi() {
  const chips = [];
  if (window.__sentimentPicked && SENTIMENT_KEYS.includes(activeFilter)) {
    chips.push({ key: 'sentiment', label: activeFilter });
  }
  if (window.__dayPicked && dateFrom.value && dateTo.value && dateFrom.value === dateTo.value) {
    chips.push({ key: 'day', label: `day ${dateFrom.value}` });
  }
  if (window.__chartMinute != null) {
    chips.push({ key: 'minute', label: `${String(window.__chartMinute).padStart(2, '0')}:xx` });
  }
  if (window.__chartAuthor) {
    chips.push({ key: 'author', label: window.__chartAuthor });
  }

  selectionChips.innerHTML = '';
  if (!chips.length) {
    selectionBar.classList.add('hidden');
  } else {
    selectionBar.classList.remove('hidden');
    chips.forEach(chip => {
      const el = document.createElement('span');
      el.className = 'selection-chip';
      el.innerHTML = `${escHtml(chip.label)} <button type="button" data-clear="${chip.key}" aria-label="Clear ${escHtml(chip.label)}">×</button>`;
      selectionChips.appendChild(el);
    });
  }

  const parts = [];
  const q = searchInput.value.trim();
  if (q) parts.push(`search "${q}"`);
  if (activeFilter !== 'all') parts.push(activeFilter);
  const ml = parseInt(minLikes.value, 10);
  if (!isNaN(ml) && ml > 0) parts.push(`min ${ml} likes`);
  if (dateFrom.value || dateTo.value) {
    parts.push(`dates ${dateFrom.value || '…'} to ${dateTo.value || '…'}`);
  }
  if (window.__chartMinute != null) parts.push(`minute ${String(window.__chartMinute).padStart(2, '0')}:xx`);
  if (window.__chartAuthor) parts.push(`author ${window.__chartAuthor}`);

  if (parts.length) {
    scopeBanner.textContent = `Showing: ${parts.join(' · ')}`;
    scopeBanner.classList.remove('hidden');
  } else {
    scopeBanner.classList.add('hidden');
  }
}

/** Clear one chart-originated filter chip and reload analytics. */
function clearChartKey(key) {
  if (key === 'sentiment') {
    window.__sentimentPicked = false;
    activeFilter = 'all';
    syncFilterTabs();
  } else if (key === 'day') {
    window.__dayPicked = false;
    dateFrom.value = '';
    dateTo.value = '';
  } else if (key === 'minute') {
    window.__chartMinute = null;
  } else if (key === 'author') {
    window.__chartAuthor = '';
  }
  persistScope();
  updateSelectionUi();
  loadAnalytics();
}

selectionChips.addEventListener('click', e => {
  const btn = e.target.closest('[data-clear]');
  if (!btn) return;
  clearChartKey(btn.dataset.clear);
});

filterTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    activeFilter = tab.dataset.filter;
    window.__sentimentPicked = SENTIMENT_KEYS.includes(activeFilter);
    syncFilterTabs();
    persistScope();
    updateSelectionUi();
    loadAnalytics();
  });
});

applyFiltersBtn.addEventListener('click', () => {
  // Manual date range is a form filter, not a chart chip
  if (!(dateFrom.value && dateTo.value && dateFrom.value === dateTo.value)) {
    window.__dayPicked = false;
  }
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
  window.__sentimentPicked = false;
  window.__dayPicked = false;
  window.__chartMinute = null;
  window.__chartAuthor = '';
  syncFilterTabs();
  sessionStorage.removeItem(SCOPE_KEY);
  updateSelectionUi();
  loadAnalytics();
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') applyFiltersBtn.click();
});

(async function init() {
  window.__chartMinute = null;
  window.__chartAuthor = '';
  window.__sentimentPicked = false;
  window.__dayPicked = false;
  readScope();
  if (window.__chartRestore) {
    if (window.__chartRestore.minute != null && window.__chartRestore.minute !== '') {
      window.__chartMinute = parseInt(window.__chartRestore.minute, 10);
    }
    if (window.__chartRestore.author) window.__chartAuthor = window.__chartRestore.author;
    if (SENTIMENT_KEYS.includes(activeFilter)) window.__sentimentPicked = true;
    if (dateFrom.value && dateTo.value && dateFrom.value === dateTo.value) window.__dayPicked = true;
  }
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
    return;
  }

  noVideoMsg.classList.add('hidden');
  updateSelectionUi();
  await loadAnalytics();
})();

/** Fetch analytics, timestamps, and comments, then render the dashboard. */
async function loadAnalytics() {
  setLoading(true);
  try {
    const body = scopePayload();
    const [analyticsRes, timestampsRes, browseRes] = await Promise.all([
      fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      fetch('/api/timestamps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      fetch('/api/browse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ]);

    const analytics = await analyticsRes.json();
    const timestamps = await timestampsRes.json();
    const browse = await browseRes.json();

    if (!analyticsRes.ok || analytics.error) throw new Error(analytics.error || 'Analytics failed.');
    if (!timestampsRes.ok || timestamps.error) throw new Error(timestamps.error || 'Timestamps failed.');
    if (!browseRes.ok || browse.error) throw new Error(browse.error || 'Could not load comments.');

    const comments = browse.comments || [];

    renderStats(analytics);
    renderSentimentChart(analytics.sentiment || {});
    renderDatesChart(analytics.dates || []);
    renderAuthors(analytics.top_authors || []);
    renderHeatmap(timestamps.heatmap || []);
    renderComments(comments);
    updateSelectionUi();

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
  if (firstLoad || !analyticsContent || analyticsContent.classList.contains('hidden')) {
    loadingMsg.classList.toggle('hidden', !on);
    if (on) analyticsContent.classList.add('hidden');
  } else {
    analyticsContent.classList.toggle('content-dim', on);
    loadingMsg.classList.add('hidden');
  }
}

/** Fill the summary stat tiles from analytics data. */
function renderStats(data) {
  document.getElementById('statComments').textContent = data.total_comments ?? 0;
  document.getElementById('statLikes').textContent = data.total_likes ?? 0;
  document.getElementById('statAuthors').textContent = data.unique_authors ?? 0;
  document.getElementById('statPositive').textContent = `${data.positive_rate ?? 0}%`;
}

/** Toggle a sentiment filter from the doughnut chart or legend. */
function toggleSentiment(label) {
  const key = String(label).toLowerCase();
  if (!SENTIMENT_KEYS.includes(key)) return;
  if (activeFilter === key && window.__sentimentPicked) {
    activeFilter = 'all';
    window.__sentimentPicked = false;
  } else {
    activeFilter = key;
    window.__sentimentPicked = true;
  }
  syncFilterTabs();
  persistScope();
  updateSelectionUi();
  loadAnalytics();
}

/** Toggle a single-day date filter from the dates chart. */
function toggleDay(dateStr) {
  if (!dateStr) return;
  if (window.__dayPicked && dateFrom.value === dateStr && dateTo.value === dateStr) {
    window.__dayPicked = false;
    dateFrom.value = '';
    dateTo.value = '';
  } else {
    window.__dayPicked = true;
    dateFrom.value = dateStr;
    dateTo.value = dateStr;
  }
  persistScope();
  updateSelectionUi();
  loadAnalytics();
}

/** Toggle a minute-of-video filter from the heatmap. */
function toggleMinute(minute) {
  if (window.__chartMinute === minute) {
    window.__chartMinute = null;
  } else {
    window.__chartMinute = minute;
  }
  persistScope();
  updateSelectionUi();
  loadAnalytics();
}

/** Toggle an author filter from the top-authors list. */
function toggleAuthor(name) {
  if (window.__chartAuthor === name) {
    window.__chartAuthor = '';
  } else {
    window.__chartAuthor = name;
  }
  persistScope();
  updateSelectionUi();
  loadAnalytics();
}

/** Draw or redraw the sentiment doughnut chart. */
function renderSentimentChart(sentiment) {
  const labels = SENTIMENT_KEYS;
  const colors = ['#27ae60', '#f39c12', '#c0392b'];
  const values = labels.map(key => sentiment[key] || 0);
  const ctx = document.getElementById('sentimentChart');

  if (sentimentChart) sentimentChart.destroy();
  sentimentChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels.map(l => l[0].toUpperCase() + l.slice(1)),
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: '#1c1c1c',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_evt, elements) => {
        if (!elements.length) return;
        toggleSentiment(labels[elements[0].index]);
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: chartDefaults.color, boxWidth: 12, padding: 14 },
          onClick: (_e, item) => toggleSentiment(labels[item.index]),
        },
      },
    },
  });
}

/** Draw or redraw the comments-over-time bar chart. */
function renderDatesChart(dates) {
  datesData = dates;
  const ctx = document.getElementById('datesChart');
  if (datesChart) datesChart.destroy();
  datesChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: dates.map(d => d.date),
      datasets: [{
        label: 'Comments',
        data: dates.map(d => d.count),
        backgroundColor: dates.map(d =>
          (window.__dayPicked && dateFrom.value === d.date) ? '#e74c3c' : '#c0392b'
        ),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_evt, elements) => {
        if (!elements.length) return;
        const dateStr = datesData[elements[0].index]?.date;
        toggleDay(dateStr);
      },
      plugins: {
        legend: { display: false },
      },
      scales: {
        x: {
          ticks: { color: chartDefaults.color, maxRotation: 45, minRotation: 0 },
          grid: { color: 'rgba(46,46,46,0.6)' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: chartDefaults.color, precision: 0 },
          grid: { color: 'rgba(46,46,46,0.6)' },
        },
      },
    },
  });
}

/** Render the clickable top-authors list. */
function renderAuthors(authors) {
  authorList.innerHTML = '';
  if (!authors.length) {
    authorList.innerHTML = '<li class="text-muted">No authors found.</li>';
    return;
  }
  authors.forEach(a => {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.classList.toggle('active', window.__chartAuthor === a.author);
    li.innerHTML = `
      <span class="author-list__name">${escHtml(a.author)}</span>
      <span class="author-list__meta">${a.total_likes} likes · ${a.comment_count} comments</span>
    `;
    const activate = () => toggleAuthor(a.author);
    li.addEventListener('click', activate);
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    authorList.appendChild(li);
  });
}

/** Render the timestamp heatmap bars for minute filters. */
function renderHeatmap(items) {
  heatmap.innerHTML = '';
  if (!items.length) {
    heatmapEmpty.classList.remove('hidden');
    return;
  }
  heatmapEmpty.classList.add('hidden');
  const max = Math.max(...items.map(i => i.count), 1);

  items.forEach(item => {
    const wrap = document.createElement('div');
    wrap.className = 'heatmap__bar-wrap';
    wrap.setAttribute('role', 'listitem');
    const height = Math.max(12, Math.round((item.count / max) * 120));
    const mm = String(item.minute).padStart(2, '0');
    const active = window.__chartMinute === item.minute;
    wrap.innerHTML = `
      <span class="heatmap__count">${item.count}</span>
      <button class="heatmap__bar${active ? ' active' : ''}" type="button" style="height: ${height}px"
              data-minute="${item.minute}" aria-label="Minute ${mm}, ${item.count} mentions"></button>
      <span class="heatmap__label">${mm}:xx</span>
    `;
    heatmap.appendChild(wrap);
  });

  heatmap.querySelectorAll('.heatmap__bar').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleMinute(parseInt(btn.dataset.minute, 10));
    });
  });
}

/** Render the filtered comment preview list (capped at 40). */
function renderComments(comments) {
  commentsEl.innerHTML = '';
  const parts = [];
  if (window.__chartMinute != null) parts.push(`${String(window.__chartMinute).padStart(2, '0')}:xx`);
  if (window.__chartAuthor) parts.push(window.__chartAuthor);
  if (window.__dayPicked && dateFrom.value) parts.push(dateFrom.value);
  if (window.__sentimentPicked) parts.push(activeFilter);

  commentsTitle.textContent = parts.length ? `Comments · ${parts.join(' · ')}` : 'Comments';
  commentsHint.textContent = parts.length
    ? 'Filtered by your chart selections. Click again on a chart to clear that slice.'
    : 'Click sentiment, a day, a minute, or an author to cross-filter.';

  if (!comments.length) {
    commentsEl.innerHTML = '<p class="text-muted">No comments for these filters.</p>';
    return;
  }
  comments.slice(0, 40).forEach(c => {
    const card = document.createElement('article');
    card.className = 'comment-card';
    card.innerHTML = `
      <div class="comment-card__meta">
        <span class="comment-card__author">${escHtml(c.author)}</span>
        <span class="badge badge--${c.sentiment_label}">${escHtml(c.sentiment_label)}</span>
        <span class="comment-card__date">${(c.published_at || '').slice(0, 10)}</span>
        <span class="comment-card__likes">${c.likes} likes</span>
      </div>
      <p class="comment-card__text">${escHtml(c.text)}</p>
    `;
    commentsEl.appendChild(card);
  });
  if (comments.length > 40) {
    const more = document.createElement('p');
    more.className = 'text-muted';
    more.textContent = `Showing 40 of ${comments.length} comments.`;
    commentsEl.appendChild(more);
  }
}

/** Escape HTML special characters for safe innerHTML insertion. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
