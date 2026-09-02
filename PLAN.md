# Work split

The product is a real website for a non-coder. They paste a YouTube link. UI matters for the hackathon, so we are not using Streamlit.

## Person A

Build `pipeline.py` first:

1. Take a YouTube link
2. Pull comments from the YouTube API
3. Clean the text
4. Create embeddings (`all-MiniLM-L6-v2`)
5. Add sentiment scores
6. Give Person B functions they can call, including `embed_query()`

Stop when those functions work on a real link. Cache (`comments.pkl`) is only for coding. Then Person A also works on the frontend so the site looks good.

## Person B

Do this after Person A's pipeline works. Do not edit `pipeline.py`. Write new files for the site.

1. Read [NOTES.md](NOTES.md) (do not run it; it is notes, not a script)
2. Follow Setup in [README.md](README.md): your own `.env`, venv, `pip install -r requirements.txt`
3. Create a new Python file (for example `app.py`) for search, topics, and filters
4. Build the website (HTML/CSS, Tailwind) with a box to paste a YouTube link
5. On submit, call `get_comments(url)` from `pipeline.py`. For the demo, call `get_comments(url, use_cache=False)`
6. Build the search bar: call `embed_query(query)`, then cosine similarity against each comment `embedding`
7. Build the Topics tab: KMeans on the comment `embedding`s
8. Add filters using `likes`, `sentiment_label`, and `published_at`
9. Do not call `fetch_comments`
