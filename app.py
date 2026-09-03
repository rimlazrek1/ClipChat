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
    return render_template("index.html")


@app.route("/search")
def search():
    return render_template("search.html")


@app.route("/topics")
def topics():
    return render_template("topics.html")


@app.route("/analytics")
def analytics():
    return render_template("analytics.html")


# ---------------------------------------------------------------------------
# Helper: apply filters to a list of comments
# ---------------------------------------------------------------------------

_QUESTION_WORDS = re.compile(r"^\s*(how|what|where|why|when|who|which|is|are|can|does|do)\b", re.IGNORECASE)
_TECH_KEYWORDS  = re.compile(r"\b(audio|cut|link|lag|loud|fixed|glitch|buffering|quality)\b", re.IGNORECASE)
_TIMESTAMP_RE   = re.compile(r"\b(\d{1,2}):(\d{2})\b")


def _apply_filters(comments: list[dict], filters: dict) -> list[dict]:
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
    if minute is not None:
        target = int(minute)
        out = [c for c in out if any(int(m.group(1)) == target for m in _TIMESTAMP_RE.finditer(c["text"]))]

    return out


# ---------------------------------------------------------------------------
# API: load comments
# ---------------------------------------------------------------------------

@app.route("/api/comments", methods=["POST"])
def api_comments():
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
    data     = request.get_json(force=True) or {}
    video_id = data.get("video_id", "")
    filters  = data.get("filters", {})

    if video_id not in _store:
        return jsonify({"error": "No comments loaded. Please go back and paste a YouTube link first."}), 400

    comments = _apply_filters(_store[video_id], filters)
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


@app.route("/api/search", methods=["POST"])
def api_search():
    data = request.get_json(force=True) or {}
    video_id = data.get("video_id", "")
    query    = data.get("query", "").strip()
    filters  = data.get("filters", {})

    if video_id not in _store:
        return jsonify({"error": "No comments loaded. Please go back and paste a YouTube link first."}), 400
    if not query:
        return jsonify({"error": "No query provided"}), 400

    comments = _apply_filters(_store[video_id], filters)
    words = [w for w in re.findall(r"[a-z0-9']+", query.lower()) if len(w) >= _MIN_WORD_LEN]
    q_vec = embed_query(query)

    scored = []
    for c in comments:
        sim = float(np.dot(q_vec, np.array(c["embedding"])))
        hay = c["text"].lower()
        has_word = any(w in hay for w in words) if words else query.lower() in hay
        if not has_word and sim < _HIGH_SIM:
            continue
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
# API: topics (KMeans + TF-IDF titles + Core Message)
# ---------------------------------------------------------------------------

@app.route("/api/topics", methods=["POST"])
def api_topics():
    data = request.get_json(force=True) or {}
    video_id   = data.get("video_id", "")
    n_clusters = int(data.get("n_clusters", 5))
    filters    = data.get("filters", {})

    if video_id not in _store:
        return jsonify({"error": "No comments loaded for this video"}), 400

    comments = _apply_filters(_store[video_id], filters)
    if len(comments) < 2:
        return jsonify({"error": "Not enough comments to cluster"}), 400

    n_clusters = min(n_clusters, len(comments))
    embeddings = np.array([c["embedding"] for c in comments])

    kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
    labels = kmeans.fit_predict(embeddings)

    # Group comments by cluster
    groups: dict[int, list] = defaultdict(list)
    for i, c in enumerate(comments):
        groups[int(labels[i])].append(c)

    # TF-IDF title + Core Message per cluster
    results = []
    for label, cluster_comments in groups.items():
        # TF-IDF top-3 terms
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

        # Core Message: comment closest to centroid
        centroid = kmeans.cluster_centers_[label]
        vecs = np.array([c["embedding"] for c in cluster_comments])
        norms = np.linalg.norm(vecs - centroid, axis=1)
        core_idx = int(np.argmin(norms))
        core = cluster_comments[core_idx]

        # Strip embeddings from output (large + not needed by frontend)
        def _strip(c):
            return {k: v for k, v in c.items() if k != "embedding"}

        results.append({
            "cluster_id": label,
            "title": title,
            "core_message": _strip(core),
            "count": len(cluster_comments),
            "comments": [_strip(c) for c in cluster_comments],
        })

    results.sort(key=lambda x: x["count"], reverse=True)
    return jsonify({"success": True, "n_clusters": n_clusters, "topics": results})


# ---------------------------------------------------------------------------
# API: timestamp heatmap
# ---------------------------------------------------------------------------

@app.route("/api/timestamps", methods=["POST"])
def api_timestamps():
    data     = request.get_json(force=True) or {}
    video_id = data.get("video_id", "")

    if video_id not in _store:
        return jsonify({"error": "No comments loaded for this video"}), 400

    counts: dict[int, int] = defaultdict(int)
    for c in _store[video_id]:
        for m in _TIMESTAMP_RE.finditer(c["text"]):
            minute = int(m.group(1))
            counts[minute] += 1

    heatmap = sorted(
        [{"minute": k, "count": v} for k, v in counts.items()],
        key=lambda x: x["minute"],
    )
    return jsonify({"success": True, "heatmap": heatmap})


# ---------------------------------------------------------------------------
# API: analytics
# ---------------------------------------------------------------------------

@app.route("/api/analytics", methods=["POST"])
def api_analytics():
    data     = request.get_json(force=True) or {}
    video_id = data.get("video_id", "")

    if video_id not in _store:
        return jsonify({"error": "No comments loaded for this video"}), 400

    comments = _store[video_id]
    total    = len(comments)
    if total == 0:
        return jsonify({"error": "No comments available"}), 400

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
    })


# ---------------------------------------------------------------------------
# API: check which video is loaded
# ---------------------------------------------------------------------------

@app.route("/api/check-video")
def api_check_video():
    video_ids = list(_store.keys())
    if not video_ids:
        return jsonify({"video_id": None, "count": 0})
    video_id = video_ids[-1]
    return jsonify({"video_id": video_id, "count": len(_store[video_id])})


# ---------------------------------------------------------------------------
# API: PDF download
# ---------------------------------------------------------------------------

def _pdf_text(value, limit=None) -> str:
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
    line = _pdf_text(text) or "-"
    pdf.set_x(pdf.l_margin)
    pdf.multi_cell(pdf.epw, height, line, wrapmode="CHAR")
    pdf.set_x(pdf.l_margin)


@app.route("/api/pdf", methods=["POST"])
def api_pdf():
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
