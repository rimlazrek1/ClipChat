import html
import os
import pickle
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from dotenv import load_dotenv
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

load_dotenv()

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_URL_RE = re.compile(r"(https?://\S+|www\.\S+)", re.IGNORECASE)
CACHE_PATH = Path("comments.pkl")
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
_model = None
_sentiment_analyzer = None


def extract_video_id(url: str) -> str:
    """
    Take a YouTube link (or a raw video id) and return the 11-character video id.
    Raises ValueError if the link is not a valid YouTube video URL.
    """
    raw = url.strip()
    if _VIDEO_ID_RE.match(raw):
        return raw

    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower().removeprefix("www.")

    if host == "youtu.be":
        video_id = parsed.path.lstrip("/").split("/")[0]
        if _VIDEO_ID_RE.match(video_id):
            return video_id

    if host in ("youtube.com", "m.youtube.com", "music.youtube.com"):
        query_id = parse_qs(parsed.query).get("v", [None])[0]
        if query_id and _VIDEO_ID_RE.match(query_id):
            return query_id

        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) >= 2 and parts[0] in ("shorts", "embed", "live"):
            video_id = parts[1]
            if _VIDEO_ID_RE.match(video_id):
                return video_id

    raise ValueError("That doesn't look like a YouTube video link. Paste the full video URL.")


def _comment_dict(item: dict) -> dict:
    """
    Turn one YouTube API comment object into a simple dictionary.
    Keeps id, text, author, like count, and publish date.
    """
    snippet = item["snippet"]
    return {
        "comment_id": item["id"],
        "text": snippet.get("textOriginal") or snippet.get("textDisplay") or "",
        "author": snippet.get("authorDisplayName", ""),
        "likes": int(snippet.get("likeCount", 0)),
        "published_at": snippet.get("publishedAt", ""),
    }


def _youtube_client():
    """
    Build the YouTube Data API client using YOUTUBE_API_KEY from .env.
    Raises an error if the key is missing.
    """
    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key:
        raise RuntimeError("The site isn't set up to load YouTube comments yet. Try again later.")
    return build("youtube", "v3", developerKey=api_key, static_discovery=True)


def fetch_comments(url: str, max_comments: int | None = None) -> list[dict]:
    """
    Call the YouTube API and pull comments for a video (top-level plus replies).
    This spends API quota. Set max_comments to stop early (for example 200).
    If max_comments is None, it keeps going until YouTube has no more pages.
    """
    video_id = extract_video_id(url)
    youtube = _youtube_client()
    comments = []

    try:
        request = youtube.commentThreads().list(
            part="snippet,replies",
            videoId=video_id,
            maxResults=100,
            textFormat="plainText",
            order="time",
        )
        while request is not None:
            response = request.execute()
            for thread in response.get("items", []):
                top = thread["snippet"]["topLevelComment"]
                comments.append(_comment_dict(top))
                if max_comments is not None and len(comments) >= max_comments:
                    return comments[:max_comments]

                for item in thread.get("replies", {}).get("comments", []):
                    comments.append(_comment_dict(item))
                    if max_comments is not None and len(comments) >= max_comments:
                        return comments[:max_comments]

            request = youtube.commentThreads().list_next(request, response)
    except HttpError as exc:
        message = str(exc)
        if "commentsDisabled" in message:
            raise RuntimeError("Comments are turned off on this video, so we can't load them.") from exc
        if exc.resp.status in (400, 403, 404):
            raise RuntimeError("We couldn't load comments for this video. Check that it is public and try again.") from exc
        raise RuntimeError("Something went wrong while loading comments. Please try again.") from exc

    return comments


def clean_text(text: str) -> str:
    """
    Clean one comment string: fix HTML codes, remove links, squeeze extra spaces.
    Returns an empty string if nothing useful is left.
    """
    text = html.unescape(text or "")
    text = _URL_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def clean_comments(comments: list[dict]) -> list[dict]:
    """
    Clean every comment. Saves the original as text_raw and the cleaned version as text.
    Drops comments that are empty after cleaning.
    """
    cleaned = []
    for comment in comments:
        text_raw = comment.get("text_raw", comment["text"])
        text = clean_text(text_raw)
        if not text:
            continue
        cleaned.append({**comment, "text_raw": text_raw, "text": text})
    return cleaned


def get_model():
    """
    Load the free local embedding model (all-MiniLM-L6-v2) the first time we need it.
    Later calls reuse the same model in memory. First load may download the model.
    """
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer(MODEL_NAME)
    return _model


def embed_query(text: str):
    """
    Turn a search phrase into an embedding vector, using the same model as the comments.
    Person B calls this for the search bar.
    """
    return get_model().encode(clean_text(text), normalize_embeddings=True)


def add_embeddings(comments: list[dict]) -> list[dict]:
    """
    Add an embedding vector to each comment from its cleaned text.
    Skips the work if embeddings are already there. Runs on your computer, not YouTube.
    """
    if not comments:
        return comments
    if "embedding" in comments[0]:
        return comments

    vectors = get_model().encode(
        [comment["text"] for comment in comments],
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return [{**comment, "embedding": vector} for comment, vector in zip(comments, vectors)]


def get_sentiment_analyzer():
    """
    Load the VADER sentiment tool the first time we need it.
    Later calls reuse it. This is free and runs on your computer, not YouTube.
    """
    global _sentiment_analyzer
    if _sentiment_analyzer is None:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

        _sentiment_analyzer = SentimentIntensityAnalyzer()
    return _sentiment_analyzer


def sentiment_label(score: float) -> str:
    """
    Turn a VADER compound score (-1 to 1) into positive, neutral, or negative.
    """
    if score >= 0.05:
        return "positive"
    if score <= -0.05:
        return "negative"
    return "neutral"


def add_sentiment(comments: list[dict]) -> list[dict]:
    """
    Add a sentiment score and label to each comment from its cleaned text.
    Skips the work if sentiment is already there.
    """
    if not comments:
        return comments
    if "sentiment" in comments[0]:
        return comments

    analyzer = get_sentiment_analyzer()
    scored = []
    for comment in comments:
        score = float(analyzer.polarity_scores(comment["text"])["compound"])
        scored.append(
            {
                **comment,
                "sentiment": score,
                "sentiment_label": sentiment_label(score),
            }
        )
    return scored


def load_cached_comments(video_id: str) -> list[dict] | None:
    """
    Read comments.pkl if it exists and matches this video id.
    Returns None if there is no file or it is for a different video.
    """
    if not CACHE_PATH.exists():
        return None
    with CACHE_PATH.open("rb") as file:
        payload = pickle.load(file)
    if payload.get("video_id") != video_id:
        return None
    return payload["comments"]


def save_cached_comments(video_id: str, comments: list[dict]) -> None:
    """
    Save comments to comments.pkl, tagged with the video id.
    Used while coding so we do not call the YouTube API on every run.
    """
    with CACHE_PATH.open("wb") as file:
        pickle.dump({"video_id": video_id, "comments": comments}, file)


def get_comments(url: str, max_comments: int | None = 200, use_cache: bool = True) -> list[dict]:
    """
    Main function Person B should call. Returns cleaned comments with embeddings
    and sentiment scores.

    If use_cache is True and comments.pkl already has this video, load that file
    (no YouTube call). If anything is still missing (clean text, embeddings, or sentiment),
    fill it in locally and save.

    If there is no cache, fetch from YouTube, clean, embed, score sentiment, then save the file.
    For the demo, call this with use_cache=False so a pasted link always fetches fresh.
    """
    video_id = extract_video_id(url)
    if use_cache:
        cached = load_cached_comments(video_id)
        if cached is not None:
            if cached and "text_raw" not in cached[0]:
                cached = clean_comments(cached)
            if cached and "embedding" not in cached[0]:
                cached = add_embeddings(cached)
            if cached and "sentiment" not in cached[0]:
                cached = add_sentiment(cached)
            save_cached_comments(video_id, cached)
            return cached

    comments = fetch_comments(url, max_comments=max_comments)
    cleaned = add_sentiment(add_embeddings(clean_comments(comments)))
    save_cached_comments(video_id, cleaned)
    return cleaned


if __name__ == "__main__":
    import sys

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    with open("url.txt", encoding="utf-8") as file:
        test_url = file.read().strip()

    results = get_comments(test_url, max_comments=200)
    print(f"{len(results)} comments ready from {extract_video_id(test_url)}")
    if results and "embedding" in results[0]:
        print(f"Embedding size: {len(results[0]['embedding'])}")
    if results and "sentiment_label" in results[0]:
        print(f"Example sentiment: {results[0]['sentiment_label']} ({results[0]['sentiment']:.2f})")
    for comment in results[:5]:
        preview = comment["text"].replace("\n", " ")[:120]
        print(f"- {comment['author']}: {preview}")
