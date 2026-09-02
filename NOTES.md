The test run in `pipeline.py` stops at 200 comments. A popular video can have thousands, which is slow and uses a lot of YouTube API quota. Keep a cap for the demo too unless the demo video is small or you accept the wait. Live fetch uses YouTube quota, so do not spam reloads on a giant video.

We added a cache (`comments.pkl` + `get_comments`) so we can clean/embed without calling the YouTube API every run. Cleaned comments (`text` + `text_raw`) and embeddings are stored in that file. After Person B finishes, stop using that cache: call `get_comments(url, use_cache=False)`, do not load `comments.pkl` on submit, and delete the file so you do not demo old comments. Fetch, clean, embed, score sentiment, and keep the result in memory.

Embeddings use `all-MiniLM-L6-v2` locally (free). Keep the model, VADER, `pipeline.py`, and `embed_query()` for the demo. Do not delete those. First run downloads the model once; that is not YouTube quota. On the demo machine, run the model once beforehand so the download is already done. First load is slow.

Sentiment uses VADER locally (free). Each comment gets `sentiment` (score) and `sentiment_label` (positive / neutral / negative).

For the demo, use a public YouTube video with comments turned on, and have a backup link. Confirm `.env` has the key on the demo machine. Never show `.env` or the key on screen or in git. Confirm the UI shows the friendly error messages from `pipeline.py` (bad link, comments off, video not public). Help with UI polish if needed. `url.txt` is only for local tests, not the product.

