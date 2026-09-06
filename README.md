# ClipChat

Paste a YouTube video link and explore its comments: search by meaning, group them into topics, and open analytics dashboards with filters and export.

---

## What it does

### Home
Paste a public YouTube URL. The app fetches comments, cleans the text, builds embeddings, and scores sentiment, then sends you to Search.

### Search
- Search by meaning (hybrid: keywords + semantic similarity)
- Filter tabs: All, Positive, Neutral, Negative, Viewer Questions, Technical Issues
- Extra filters: min likes, date range
- Recent searches saved in the browser
- Analyze results → Analytics with the same filters
- Export → CSV or PDF

### Topics
- Groups comments with KMeans
- Each topic has a TF-IDF title, a Core Message, and its comments
- Same filters as Search, plus number of groups (3 / 5 / 7 / 10)
- Topic analytics → Topic Analytics with the same scope
- Export → CSV or PDF

### Analytics
- Stats: comments, likes, unique authors, positive rate
- Charts: sentiment, comments per day, timestamp heatmap (times like `3:15`, grouped by minute)
- Top authors and a comment list
- Filters plus chart clicks (sentiment, day, minute, author) that update the whole page
- Export → CSV or PDF

### Topic Analytics
- Compare topics by size, sentiment, and likes
- Breakdown cards with each topic’s core message
- Same filters and group count; click a topic to focus the charts
- Export → CSV or PDF

---

## Cap and cache

- **Cap:** at most **200** comments per video, to keep load time and YouTube API quota under control.
- **Cache:** after a video is processed, results are saved in `comments.pkl`. Loading the **same** video again reuses that file (no full re-fetch / re-embed). A different video is fetched fresh.

---

## Setup

1. Enable **YouTube Data API v3** and create an API key in Google Cloud.
2. Add a local `.env` file (do not commit it):

   ```
   YOUTUBE_API_KEY=your_key_here
   ```

3. Create and activate a virtual environment:

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   ```

4. Install packages:

   ```bash
   pip install -r requirements.txt
   ```

---

## Launch the app

```bash
python app.py
```

Then open [http://127.0.0.1:5000](http://127.0.0.1:5000).

First model load and first search can be slower; later ones are faster if you keep the server running.

---

## Project structure

```
app.py              Flask pages and APIs
pipeline.py         YouTube fetch, cleaning, embeddings, sentiment
templates/          HTML pages
static/css/         Styles
static/js/          Frontend logic and export
requirements.txt
```

---

## Main routes

**Pages:** `/` · `/search` · `/topics` · `/analytics` · `/topic-analytics`

**APIs:** `/api/comments` · `/api/browse` · `/api/search` · `/api/topics` · `/api/topic-analytics` · `/api/timestamps` · `/api/analytics` · `/api/check-video` · `/api/pdf`
