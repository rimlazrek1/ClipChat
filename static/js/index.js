/* ── Toast helper ─────────────────────────────────────────── */
const toast = document.getElementById('toast');
let toastTimer;

/** Show a temporary toast message. */
function showToast(msg, type = 'error') {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = `toast toast--${type} show`;
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}

/* ── Elements ─────────────────────────────────────────────── */
const urlInput   = document.getElementById('urlInput');
const analyseBtn = document.getElementById('analyseBtn');
const loading    = document.getElementById('loadingState');

/* ── Submit ───────────────────────────────────────────────── */
/** Fetch comments for the entered YouTube URL and redirect to search. */
async function handleSubmit() {
  const url = urlInput.value.trim();
  if (!url) {
    showToast('Please paste a YouTube link first.');
    urlInput.focus();
    return;
  }

  // Show loading
  analyseBtn.disabled = true;
  analyseBtn.textContent = 'Loading…';
  loading.classList.remove('hidden');

  try {
    const res  = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || 'Something went wrong.');
    }

    // Store video_id for other pages
    sessionStorage.setItem('video_id', data.video_id);
    sessionStorage.setItem('comment_count', data.count);

    showToast(`Loaded ${data.count} comments!`, 'success');

    // Redirect to search after a short pause
    setTimeout(() => { window.location.href = '/search'; }, 900);

  } catch (err) {
    showToast(err.message);
    analyseBtn.disabled = false;
    analyseBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
        <path d="m21 21-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      Analyse`;
    loading.classList.add('hidden');
  }
}

analyseBtn.addEventListener('click', handleSubmit);
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleSubmit(); });
