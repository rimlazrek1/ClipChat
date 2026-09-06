import io
import re
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np
from flask import Flask, jsonify, render_template, request, send_file
from fpdf import FPDF
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import TfidfVectorizer

from pipeline import embed_query, extract_video_id, get_comments

app = Flask(__name__)

# Server-side comment store keyed by video_id
_store: dict[str, list[dict]] = {}

# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    """Render the home page where the user pastes a YouTube link."""
    return render_template("index.html")


@app.route("/search")
def search():
    """Render the search / browse comments page."""
    return render_template("search.html")


@app.route("/topics")
def topics():
    """Render the topic clustering page."""
    return render_template("topics.html")


@app.route("/analytics")
def analytics():
    """Render the comment analytics dashboard."""
    return render_template("analytics.html")


@app.route("/topic-analytics")
def topic_analytics():
    """Render the topic-comparison analytics dashboard."""
    return render_template("topic_analytics.html")


# ---------------------------------------------------------------------------
# Helper: apply filters to a list of comments
# ---------------------------------------------------------------------------

_QUESTION_WORDS = re.compile(r"^\s*(how|what|where|why|when|who|which|is|are|can|does|do)\b", re.IGNORECASE)
_TECH_KEYWORDS  = re.compile(r"\b(audio|cut|link|lag|loud|fixed|glitch|buffering|quality)\b", re.IGNORECASE)
_TIMESTAMP_RE   = re.compile(r"\b(\d{1,2}):(\d{2})\b")


def _apply_filters(comments: list[dict], filters: dict) -> list[dict]:
    """
    Filter comments by sentiment tabs, likes, date range, minute mark, and author.

    ``filters`` may include ``sentiment``, ``min_likes``, ``date_from``, ``date_to``,
    ``minute``, and ``author``.
    """
    out = comments

    sentiment = filters.get("sentiment")
    if sentiment and sentiment != "all":
        if sentiment == "questions":
            out = [c for c in out if "?" in c["text"] or _QUESTION_WORDS.match(c["text"])]
        elif sentiment == "technical":
            out = [c for c in out if c["sentiment_label"] == "negative" and _TECH_KEYWORDS.search(c["text"])]
        else:
            out = [c for c in out if c["sentiment_label"] == sentiment]

    min_likes = filters.get("min_likes")
    if min_likes is not None:
        out = [c for c in out if c["likes"] >= int(min_likes)]

    date_from = filters.get("date_from")
    date_to = filters.get("date_to")

    # From only → that day onward until now.
    # To only → everything before that day (inclusive).
    # Both → that range. Neither → no date filter.
    if date_from:
        out = [c for c in out if c["published_at"] >= date_from]
        if not date_to:
            now = datetime.now(timezone.utc).isoformat()
            out = [c for c in out if c["published_at"] <= now]

    if date_to:
        # Include the whole selected day
        end = date_to if "T" in str(date_to) else f"{date_to}T23:59:59"
        out = [c for c in out if c["published_at"] <= end]

    minute = filters.get("minute")  # e.g. "3" → filter comments mentioning 3:xx
    if minute is not None and minute != "":
        target = int(minute)
        out = [c for c in out if any(int(m.group(1)) == target for m in _TIMESTAMP_RE.finditer(c["text"]))]

    author = (filters.get("author") or "").strip()
    if author:
        out = [c for c in out if (c.get("author") or "") == author]

    return out


# ---------------------------------------------------------------------------
# API: load comments
# ---------------------------------------------------------------------------

@app.route("/api/comments", methods=["POST"])
def api_comments():
    """Fetch comments for a YouTube URL, store them in memory, and return the video id."""
    data = request.get_json(force=True)
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    try:
        video_id = extract_video_id(url)
        comments = get_comments(url, max_comments=200, use_cache=True)
        _store[video_id] = comments
        return jsonify({
            "success": True,
            "video_id": video_id,
            "count": len(comments),
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ---------------------------------------------------------------------------
# API: browse all (no query, sorted by likes)
# ---------------------------------------------------------------------------

@app.route("/api/browse", methods=["POST"])
def api_browse():
    """Return filtered comments for a video, sorted by likes (embeddings stripped)."""
    data     = request.get_json(force=True) or {}
    video_id = data.get("video_id", "")
    filters  = data.get("filters", {})
    query    = (data.get("query") or "").strip()

    if video_id not in _store:
        return jsonify({"error": "No comments loaded. Please go back and paste a YouTube link first."}), 400

    comments = _filter_by_query(_apply_filters(_store[video_id], filters), query)
    stripped = [{k: v for k, v in c.items() if k != "embedding"} for c in comments]
    stripped.sort(key=lambda x: x["likes"], reverse=True)
    total_loaded = len(_store[video_id])
    return jsonify({
        "success": True,
        "count": len(stripped),
        "total_loaded": total_loaded,
        "comments": stripped,
    })


# ---------------------------------------------------------------------------
# API: semantic search (high score OR contains a query word)
# ---------------------------------------------------------------------------

_MIN_WORD_LEN = 3
_HIGH_SIM = 0.48


def _filter_by_query(comments: list[dict], query: str) -> list[dict]:
    """Keep comments that contain a query word or score high on meaning."""
    query = (query or "").strip()
    if not query:
        return comments

    words = [w for w in re.findall(r"[a-z0-9']+", query.lower()) if len(w) >= _MIN_WORD_LEN]
    q_vec = embed_query(query)
    matched = []
    for c in comments:
        sim = float(np.dot(q_vec, np.array(c["embedding"])))
        hay = c["text"].lower()
        has_word = any(w in hay for w in words) if words else query.lower() in hay
        if has_word or sim >= _HIGH_SIM:
            matched.append(c)
    return matched


@app.route("/api/search", methods=["POST"])
def api_search():
    """Semantic + keyword search over loaded comments; results ranked by similarity."""
    data = request.get_json(force=True) or {}
    video_id = data.get("video_id", "")
    query    = data.get("query", "").strip()
    filters  = data.get("filters", {})

    if video_id not in _store:
        return jsonify({"error": "No comments loaded. Please go back and paste a YouTube link first."}), 400
    if not query:
        return jsonify({"error": "No query provided"}), 400

    comments = _filter_by_query(_apply_filters(_store[video_id], filters), query)
    q_vec = embed_query(query)

    scored = []
    for c in comments:
        sim = float(np.dot(q_vec, np.array(c["embedding"])))
        scored.append({**c, "similarity": round(sim, 4), "embedding": None})

    scored.sort(key=lambda x: x["similarity"], reverse=True)
    total_loaded = len(_store[video_id])
    return jsonify({
        "success": True,
        "count": len(scored),
        "total_loaded": total_loaded,
        "comments": scored,
    })


# ---------------------------------------------------------------------------
# Helper: build topic clusters (shared by topics + topic-analytics)
# ---------------------------------------------------------------------------

def _strip_comment(c: dict) -> dict:
    """Return a comment dict without the large embedding vector."""
    return {k: v for k, v in c.items() if k != "embedding"}


def _build_topics(comments: list[dict], n_clusters: int) -> tuple[list[dict], int]:
    """
    Cluster comments with KMeans, name each group with TF-IDF, and pick a core message.

    Returns ``(topic_list, n_clusters_used)``. Topics are sorted by size descending.
    """
    if len(comments) < 2:
        return [], 0

    n_clusters = min(max(2, n_clusters), len(comments))
    embeddings = np.array([c["embedding"] for c in comments])

    kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
    labels = kmeans.fit_predict(embeddings)

    groups: dict[int, list] = defaultdict(list)
    for i, c in enumerate(comments):
        groups[int(labels[i])].append(c)

    results = []
    for label, cluster_comments in groups.items():
        texts = [c["text"] for c in cluster_comments]
        try:
            tfidf = TfidfVectorizer(stop_words="english", max_features=500)
            matrix = tfidf.fit_transform(texts)
            scores = np.asarray(matrix.sum(axis=0)).flatten()
            top_idx = scores.argsort()[-3:][::-1]
            terms = [tfidf.get_feature_names_out()[i] for i in top_idx]
            title = ", ".join(terms)
        except Exception:
            title = "general discussion"

        centroid = kmeans.cluster_centers_[label]
        vecs = np.array([c["embedding"] for c in cluster_comments])
        norms = np.linalg.norm(vecs - centroid, axis=1)
        core = cluster_comments[int(np.argmin(norms))]

        results.append({
            "cluster_id": label,
            "title": title,
            "core_message": _strip_comment(core),
            "count": len(cluster_comments),
            "comments": [_strip_comment(c) for c in cluster_comments],
        })

    results.sort(key=lambda x: x["count"], reverse=True)
    return results, n_clusters


# ---------------------------------------------------------------------------
# API: topics (KMeans + TF-IDF titles + Core Message)
# ---------------------------------------------------------------------------

@app.route("/api/topics", methods=["POST"])
def api_topics():
    """Cluster filtered comments into topics with titles and core messages."""
    data = request.get_json(force=True) or {}
    video_id   = data.get("video_id", "")
    n_clusters = int(data.get("n_clusters", 5))
    filters    = data.get("filters", {})
    query      = (data.get("query") or "").strip()

    if video_id not in _store:
        return jsonify({"error": "No comments loaded for this video"}), 400

    comments = _filter_by_query(_apply_filters(_store[video_id], filters), query)
    if len(comments) < 2:
        return jsonify({"error": "Not enough comments to cluster"}), 400

    results, n_clusters = _build_topics(comments, n_clusters)
    return jsonify({"success": True, "n_clusters": n_clusters, "topics": results})


# ---------------------------------------------------------------------------
# API: topic analytics (per-cluster comparison stats)
# ---------------------------------------------------------------------------

@app.route("/api/topic-analytics", methods=["POST"])
def api_topic_analytics():
    """Return per-topic size, likes, and sentiment stats for comparison charts."""
    data = request.get_json(force=True) or {}
    video_id   = data.get("video_id", "")
    n_clusters = int(data.get("n_clusters", 5))
    filters    = data.get("filters", {})
    query      = (data.get("query") or "").strip()

    if video_id not in _store:
        return jsonify({"error": "No comments loaded for this video"}), 400

    comments = _filter_by_query(_apply_filters(_store[video_id], filters), query)
    if len(comments) < 2:
        return jsonify({"error": "Not enough comments to cluster"}), 400

    topics, n_clusters = _build_topics(comments, n_clusters)

    topic_stats = []
    total_likes = 0
    authors = set()
    for t in topics:
        sentiment = defaultdict(int)
        likes = 0
        for c in t["comments"]:
            sentiment[c["sentiment_label"]] += 1
            likes += int(c.get("likes") or 0)
            authors.add(c.get("author"))
        total_likes += likes
        count = t["count"] or 1
        topic_stats.append({
            "cluster_id": t["cluster_id"],
            "title": t["title"],
            "count": t["count"],
            "total_likes": likes,
            "avg_likes": round(likes / count, 1),
            "sentiment": {
                "positive": sentiment.get("positive", 0),
                "neutral": sentiment.get("neutral", 0),
                "negative": sentiment.get("negative", 0),
            },
            "positive_rate": round(100 * sentiment.get("positive", 0) / count),
            "core_message": t["core_message"],
        })

    return jsonify({
        "success": True,
        "n_clusters": n_clusters,
        "total_comments": len(comments),
        "total_likes": total_likes,
        "unique_authors": len(authors),
        "topics": topic_stats,
    })


# ---------------------------------------------------------------------------
# API: timestamp heatmap
# ---------------------------------------------------------------------------

@app.route("/api/timestamps", methods=["POST"])
def api_timestamps():
    """Count timestamp mentions in comments, grouped by minute (e.g. 3:xx)."""
    data     = request.get_json(force=True) or {}
    video_id = data.get("video_id", "")
    filters  = data.get("filters", {})
    query    = (data.get("query") or "").strip()

    if video_id not in _store:
        return jsonify({"error": "No comments loaded for this video"}), 400

    comments = _filter_by_query(_apply_filters(_store[video_id], filters), query)
    counts: dict[int, int] = defaultdict(int)
    for c in comments:
        for m in _TIMESTAMP_RE.finditer(c["text"]):
            minute = int(m.group(1))
            counts[minute] += 1

    heatmap = sorted(
        [{"minute": k, "count": v} for k, v in counts.items()],
        key=lambda x: x["minute"],
    )
    return jsonify({"success": True, "heatmap": heatmap, "count": len(comments)})


# ---------------------------------------------------------------------------
# API: analytics
# ---------------------------------------------------------------------------

@app.route("/api/analytics", methods=["POST"])
def api_analytics():
    """Return summary stats, sentiment mix, daily activity, and top authors."""
    data     = request.get_json(force=True) or {}
    video_id = data.get("video_id", "")
    filters  = data.get("filters", {})
    query    = (data.get("query") or "").strip()

    if video_id not in _store:
        return jsonify({"error": "No comments loaded for this video"}), 400

    comments = _filter_by_query(_apply_filters(_store[video_id], filters), query)
    total    = len(comments)
    if total == 0:
        return jsonify({"error": "No comments available for these filters"}), 400

    sentiment_counts = defaultdict(int)
    date_counts      = defaultdict(int)
    author_stats     = defaultdict(lambda: {"likes": 0, "count": 0})

    for c in comments:
        sentiment_counts[c["sentiment_label"]] += 1
        date_counts[c["published_at"][:10]] += 1
        author_stats[c["author"]]["likes"] += c["likes"]
        author_stats[c["author"]]["count"] += 1

    top_authors = sorted(
        [{"author": k, "total_likes": v["likes"], "comment_count": v["count"]}
         for k, v in author_stats.items()],
        key=lambda x: x["total_likes"],
        reverse=True,
    )[:5]

    dates = [{"date": d, "count": n}
             for d, n in sorted(date_counts.items())[-30:]]

    positive_rate = round(sentiment_counts["positive"] / total * 100)

    return jsonify({
        "success": True,
        "total_comments": total,
        "total_likes": sum(c["likes"] for c in comments),
        "unique_authors": len(author_stats),
        "positive_rate": positive_rate,
        "sentiment": dict(sentiment_counts),
        "dates": dates,
        "top_authors": top_authors,
        "filtered": bool(query or (filters and any(filters.values()))),
        "query": query,
    })


# ---------------------------------------------------------------------------
# API: check which video is loaded
# ---------------------------------------------------------------------------

@app.route("/api/check-video")
def api_check_video():
    """Return the most recently loaded video id and comment count, if any."""
    video_ids = list(_store.keys())
    if not video_ids:
        return jsonify({"video_id": None, "count": 0})
    video_id = video_ids[-1]
    return jsonify({"video_id": video_id, "count": len(_store[video_id])})


# ---------------------------------------------------------------------------
# API: PDF download
# ---------------------------------------------------------------------------

def _pdf_text(value, limit=None) -> str:
    """Sanitize text for FPDF (ASCII-safe, wrapped long words, optional length cap)."""
    text = str(value or "").replace("\r", " ").replace("\n", " ").replace("\t", " ")
    text = "".join(ch if 32 <= ord(ch) <= 126 else "?" for ch in text)
    text = " ".join(text.split())
    chunks = []
    for word in text.split(" "):
        while len(word) > 40:
            chunks.append(word[:40])
            word = word[40:]
        if word:
            chunks.append(word)
    text = " ".join(chunks)
    if limit is not None:
        return text[:limit]
    return text


def _pdf_line(pdf, text, height=5):
    """Write one wrapped line to the PDF and reset the cursor to the left margin."""
    line = _pdf_text(text) or "-"
    pdf.set_x(pdf.l_margin)
    pdf.multi_cell(pdf.epw, height, line, wrapmode="CHAR")
    pdf.set_x(pdf.l_margin)


@app.route("/api/pdf", methods=["POST"])
def api_pdf():
    """Build and download a simple PDF export of the given comments list."""
    data     = request.get_json(force=True) or {}
    video_id = data.get("video_id", "")
    comments = data.get("comments")
    title    = data.get("title", f"Comments - {video_id}")

    if not comments and video_id in _store:
        comments = [{k: v for k, v in c.items() if k != "embedding"} for c in _store[video_id]]

    if not comments:
        return jsonify({"error": "No comments to export"}), 400

    try:
        pdf = FPDF()
        pdf.set_auto_page_break(auto=True, margin=15)
        pdf.add_page()
        pdf.set_font("Helvetica", "B", 14)
        _pdf_line(pdf, title, 8)
        pdf.set_font("Helvetica", "", 9)
        pdf.ln(2)

        for c in comments:
            author    = _pdf_text(c.get("author", ""), 80)
            text      = _pdf_text(c.get("text", ""))
            likes     = c.get("likes", 0)
            sentiment = _pdf_text(c.get("sentiment_label", ""), 20)
            date      = _pdf_text(c.get("published_at", ""), 10)
            header    = f"{author} | {date} | {likes} likes | {sentiment}"

            pdf.set_font("Helvetica", "B", 9)
            _pdf_line(pdf, header)
            pdf.set_font("Helvetica", "", 9)
            _pdf_line(pdf, text or "(no text)")
            pdf.ln(2)

        buf = io.BytesIO(bytes(pdf.output()))
        buf.seek(0)
        return send_file(buf, mimetype="application/pdf",
                         as_attachment=True, download_name="comments.pdf")
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000, use_reloader=False)
