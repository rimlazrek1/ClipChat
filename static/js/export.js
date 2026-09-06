/** Escape a value for safe CSV cell output. */
function csvEscape(value) {
  const text = String(value == null ? '' : value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Trigger a browser download for the given blob. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Build and download a CSV file from comment rows. */
function exportCommentsCsv(rows, filename = 'comments.csv') {
  const headers = ['author', 'text', 'likes', 'sentiment_label', 'published_at'];
  const lines = [headers.join(',')];
  rows.forEach(row => {
    lines.push(headers.map(key => csvEscape(row[key])).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, filename);
}

/**
 * Request a PDF export from the server and download it.
 * @param {object} opts
 * @param {string} opts.videoId
 * @param {object[]} opts.comments
 * @param {string} opts.title
 * @param {string} [opts.filename]
 */
async function exportCommentsPdf({ videoId, comments, title, filename = 'comments.pdf', onError }) {
  const res = await fetch('/api/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video_id: videoId,
      comments: comments.map(c => ({
        author: c.author,
        text: c.text,
        likes: c.likes,
        sentiment_label: c.sentiment_label,
        published_at: c.published_at,
      })),
      title,
    }),
  });
  if (!res.ok) {
    let msg = 'PDF export failed.';
    try {
      const err = await res.json();
      if (err.error) msg = err.error;
    } catch (_) {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  downloadBlob(blob, filename);
}

/**
 * Wire up CSV/PDF export menu toggle and format buttons.
 * @param {object} opts - Root element plus getters for rows, title, filename, videoId, and onError.
 */
function setupExportMenu({ root, getRows, getTitle, getFilenameBase, getVideoId, onError }) {
  if (!root) return;
  const toggle = root.querySelector('[data-export-toggle]');
  const menu = root.querySelector('[data-export-menu]');
  if (!toggle || !menu) return;

  /** Collapse the export dropdown. */
  function closeMenu() {
    menu.classList.add('hidden');
    toggle.setAttribute('aria-expanded', 'false');
  }

  /** Expand the export dropdown. */
  function openMenu() {
    menu.classList.remove('hidden');
    toggle.setAttribute('aria-expanded', 'true');
  }

  toggle.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) openMenu();
    else closeMenu();
  });

  document.addEventListener('click', e => {
    if (!root.contains(e.target)) closeMenu();
  });

  menu.querySelectorAll('[data-export-format]').forEach(btn => {
    btn.addEventListener('click', async () => {
      closeMenu();
      const format = btn.dataset.exportFormat;
      const rows = getRows();
      if (!rows || !rows.length) {
        if (onError) onError('Nothing to export.');
        return;
      }
      const base = getFilenameBase ? getFilenameBase() : 'export';
      const title = getTitle ? getTitle() : base;
      try {
        if (format === 'csv') {
          exportCommentsCsv(rows, `${base}.csv`);
        } else if (format === 'pdf') {
          await exportCommentsPdf({
            videoId: getVideoId ? getVideoId() : '',
            comments: rows,
            title,
            filename: `${base}.pdf`,
          });
        }
      } catch (err) {
        if (onError) onError(err.message);
      }
    });
  });
}
