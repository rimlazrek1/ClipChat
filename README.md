## Comment Intelligence Tool

Who does what: see [PLAN.md](PLAN.md).
> A tool that pulls all comments from a YouTube video and lets a creator either search them by meaning or see them auto-grouped by topic, instead of scrolling hundreds of comments by hand. The UI is a real website (not Streamlit).
## Setup
Each person makes their own `.env`. Where they store the API key:

1. Create a Google Cloud API key (YouTube Data API v3)
2. Put it in a local `.env` file: `YOUTUBE_API_KEY=your_key_here`
3. Create a virtual env: `python -m venv .venv`
4. Activate it: `.\.venv\Scripts\Activate.ps1` (Windows) or `source .venv/bin/activate` (Mac/Linux)
5. Install packages: `pip install -r requirements.txt`
## Run the pipeline
Activate the venv first. Put a YouTube link in `url.txt`, then:

`python pipeline.py`

The first run calls the YouTube API and saves `comments.pkl`. Later runs reuse that file (no extra quota).
## What it does
- Pulls all comments from a video (or channel)
- Turns each comment into a vector (embedding) that captures its meaning, not just its
words
- Search bar: type a query like "audio problems" → get back comments that match in meaning, even if they use different words ("can't hear you," "sound cuts out")
- Topics tab: auto-groups all comments into clusters (e.g. "sponsor complaints," "editing feedback," "questions about gear") without the creator typing anything
- Filters: sort by likes, filter by sentiment (positive/negative), filter by date
## Why it's useful
- Saves an editor from manually reading hundreds of comments
- Finds specific feedback (bugs, requests, reactions) fast
- Gives a quick "what is my audience talking about" overview after upload
## Tools needed
- `google-api-python-client` — pull comments (YouTube Data API v3, just an API key, no OAuth needed)
- sentence-transformers (model: `all-MiniLM-L6-v2`) — turn comments into embeddings, runs on CPU
- `numpy` — cosine similarity for search (or faiss-cpu if comment count is very large)
- `scikit-learn` — KMeans clustering for the Topics tab (reuses the same embeddings)
- `vaderSentiment` — sentiment scoring for filters
- HTML/CSS (Tailwind) — website UI
## Core pipeline (shared by both features)
> 1 Pull comments → 2 Embed comments → 3a Search = compare query embedding to comment embeddings → 3b Topics = cluster comment embeddings