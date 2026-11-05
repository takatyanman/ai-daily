#!/usr/bin/env python3
"""Generate attributed, offline Japanese MP3 editions from public article JSON.

Ubuntu dependencies: open-jtalk open-jtalk-mecab-naist-jdic
hts-voice-nitech-jp-atr503-m001 ffmpeg. Speech synthesis runs offline; optional
HTTPS archive reuse preserves published audio. No remote AI/TTS API is used.
"""

from __future__ import annotations

import argparse
import array
from contextlib import ExitStack
import datetime as dt
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import wave


ROOT = Path(__file__).resolve().parent.parent
MAX_DAYS = 14
MAX_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_MANIFEST_BYTES = 2 * 1024 * 1024
ARCHIVE_DOWNLOAD_ATTEMPTS = 3
MAX_ARTICLE_SECONDS = 1800
MAX_INPUT_BYTES = 300
MAX_TRACE_BYTES = 16 * 1024 * 1024
MAX_TRACE_LABELS = 4096
TRACE_TICKS_PER_SECOND = 10_000_000
SLOW_PHONEME_SECONDS = 0.25
SLOW_PHONEME_RUN = 4
MIN_REPAIR_BYTES = 30
MAX_REPAIR_DEPTH = 6
MAX_SYNTHESIS_CALLS = 31
CHUNK_PAUSE_SECONDS = 0.20
LEADING_PAUSE_SECONDS = 0.12
TRAILING_PAUSE_SECONDS = 0.85
VOICE = {
    "name": "HTS Voice nitech_jp_atr503_m001",
    "credit": "Nagoya Institute of Technology・Tokyo Institute of Technology",
    "licenseTitle": "CC BY 3.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/3.0/",
    "sourceUrl": "https://changelogs.ubuntu.com/changelogs/pool/multiverse/h/hts-voice-nitech-jp-atr503-m001/hts-voice-nitech-jp-atr503-m001_1.05-8/copyright",
}
DAY_FILE = re.compile(r"\d{4}-\d{2}-\d{2}\.json\Z")
MP3_FILE = re.compile(r"\d{4}-\d{2}-\d{2}-[a-f0-9]{12}\.mp3\Z")
URL = re.compile(r"https?://[^\s<>「」『』（）()、。]+", re.IGNORECASE)
# Keep Latin words and formatted numbers intact across both kinds of splitting.
# A comma/decimal point between digits belongs to the token, as does its percent.
SPEECH_TOKEN = re.compile(r"[A-Za-z0-9_]+(?:[.,:/+\-][A-Za-z0-9_]+)*(?:[%％])?")
MATH_OPERATORS = "×÷＋−－＝"
NUMERIC_OPERAND = r"[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?[%％]?"
NUMERIC_EXPRESSION = re.compile(
    rf"\s*{NUMERIC_OPERAND}(?:\s*[{MATH_OPERATORS}]\s*{NUMERIC_OPERAND})+\s*[。！？!?]?\s*")


class AudioError(ValueError):
    pass


def compact_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def article_hash(article: dict) -> str:
    """Match JSON.stringify([id,title,body,section pairs,action]) in the player."""
    reading = article.get("reading") or {}
    payload = [article["id"], article["title"], article["body"],
               [[section["heading"], section["start"]]
                for section in reading.get("sections", [])],
               reading.get("action") or ""]
    return hashlib.sha256(compact_json(payload).encode("utf-8")).hexdigest()


def paragraphs(article: dict) -> list[str]:
    return [part for part in re.split(r"\r?\n\s*\r?\n", article["body"].strip()) if part]


def required_text(value: object, maximum: int, label: str) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise AudioError(f"Invalid {label}")
    if any(0xD800 <= ord(char) <= 0xDFFF or
           (ord(char) < 32 and char not in "\n\r\t") for char in value):
        raise AudioError(f"Invalid characters in {label}")


def validate_day(day: object, filename: str) -> dict:
    if not isinstance(day, dict) or not isinstance(day.get("date"), str):
        raise AudioError(f"Invalid edition in {filename}")
    date = day["date"]
    try:
        if dt.date.fromisoformat(date).isoformat() != date or filename != date + ".json":
            raise ValueError()
    except ValueError as exc:
        raise AudioError(f"Invalid edition date in {filename}") from exc
    articles = day.get("articles")
    if not isinstance(articles, list) or len(articles) != 3:
        raise AudioError(f"Exactly three articles required in {filename}")
    for index, article in enumerate(articles, 1):
        if not isinstance(article, dict) or article.get("id") != f"{date}-{index}":
            raise AudioError(f"Invalid article ID in {filename}")
        for key, maximum in (("title", 200), ("body", 20000)):
            required_text(article.get(key), maximum, f"{article['id']} {key}")
        reading = article.get("reading")
        if reading is None:
            continue
        if not isinstance(reading, dict):
            raise AudioError(f"Invalid reading guide for {article['id']}")
        sections = reading.get("sections", [])
        if not isinstance(sections, list):
            raise AudioError(f"Invalid sections for {article['id']}")
        previous = -1
        count = len(paragraphs(article))
        for section in sections:
            if not isinstance(section, dict):
                raise AudioError(f"Invalid section for {article['id']}")
            required_text(section.get("heading"), 50, "section heading")
            start = section.get("start")
            if type(start) is not int or not previous < start < count:
                raise AudioError(f"Invalid section position for {article['id']}")
            previous = start
        if sections and sections[0]["start"] != 0:
            raise AudioError(f"Sections must begin at paragraph zero for {article['id']}")
        if "action" in reading:
            required_text(reading["action"], 200, "reading action")
    return day


def load_days(project_root: Path) -> list[dict]:
    """Read only complete public editions, never drafts or private sidecars."""
    content = project_root / "content"
    if content.is_symlink() or not content.is_dir():
        raise AudioError("Public content must be a real directory")
    days = []
    for path in sorted(content.iterdir()):
        if not DAY_FILE.fullmatch(path.name):
            continue
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024:
            raise AudioError(f"Invalid public edition file: {path.name}")
        try:
            day = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError) as exc:
            raise AudioError(f"Invalid JSON in {path.name}") from exc
        days.append(validate_day(day, path.name))
    if not days:
        raise AudioError("At least one complete public edition is required")
    return days[-MAX_DAYS:]


def speech_segments(article: dict) -> list[dict[str, str]]:
    """Keep visible text units separate so each cue measures real synthesized PCM."""
    reading = article.get("reading") or {}
    headings = {section["start"]: section["heading"] for section in reading.get("sections", [])}
    segments = [("title", article["title"])]
    for index, paragraph in enumerate(paragraphs(article)):
        if index in headings:
            segments.append((f"section-{index}", headings[index]))
        segments.append((f"paragraph-{index}", paragraph))
    if reading.get("action"):
        segments.extend([("action-heading", "ひとつ、試してみる"), ("action", reading["action"])])
    spoken = []
    for key, text in segments:
        # The Open JTalk CLI reads one input line, including when stdin is used.
        chunk = re.sub(r"\s+", " ", URL.sub("", text)).strip()
        if chunk:
            spoken.append({"key": key, "text": text,
                           "spoken": chunk if chunk[-1] in "。！？!?" else chunk + "。"})
    return spoken


def speech_text(article: dict) -> str:
    """Speak title, sectioned body, and action once; omit visual/source material."""
    return " ".join(segment["spoken"] for segment in speech_segments(article)) + "\n"


def safe_split_offsets(text: str) -> list[tuple[int, int]]:
    """Return character/UTF-8 boundaries outside words and formatted numbers."""
    protected = {index for token in SPEECH_TOKEN.finditer(text)
                 for index in range(token.start() + 1, token.end())}
    offsets = []
    cursor = 0
    for index, char in enumerate(text, 1):
        cursor += len(char.encode("utf-8"))
        if index not in protected:
            offsets.append((index, cursor))
    return offsets


def speech_chunks(text: str) -> list[str]:
    """Stay below the CLI's byte buffer, preferring sentence/phrase boundaries."""
    remaining = re.sub(r"\s+", " ", text).strip()
    chunks = []
    while remaining:
        offsets = [(index, size) for index, size in safe_split_offsets(remaining)
                   if size <= MAX_INPUT_BYTES]
        if not offsets:
            raise AudioError("A speech token exceeds the Open JTalk input byte limit")
        end = offsets[-1][0]
        if end < len(remaining):
            # Retain punctuation and all content, even in unusually long sentences.
            boundaries = [index for index, _ in offsets
                          if remaining[index - 1] in "。！？!?、，, "]
            if boundaries and boundaries[-1] >= end // 3:
                end = boundaries[-1]
        chunk = remaining[:end].strip()
        if chunk:
            chunks.append(chunk)
        remaining = remaining[end:].lstrip()
    return chunks


def command(arguments: list[str], *, input_text: str | None = None, timeout: int = 180) -> str:
    try:
        result = subprocess.run(arguments, input=input_text, text=True, encoding="utf-8",
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                check=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as exc:
        details = getattr(exc, "stderr", "") or str(exc)
        raise AudioError(f"{Path(arguments[0]).name} failed: {str(details)[-2000:]}") from exc
    return result.stdout


def toolchain() -> dict[str, str]:
    paths = {
        "open_jtalk": shutil.which(os.environ.get("OPEN_JTALK_BIN", "open_jtalk")),
        "ffmpeg": shutil.which("ffmpeg"),
        "ffprobe": shutil.which("ffprobe"),
        "dictionary": os.environ.get("OPEN_JTALK_DIC", "/var/lib/mecab/dic/open-jtalk/naist-jdic"),
        "voice": os.environ.get("OPEN_JTALK_VOICE", "/usr/share/hts-voice/nitech-jp-atr503-m001/nitech_jp_atr503_m001.htsvoice"),
    }
    for name in ("open_jtalk", "ffmpeg", "ffprobe"):
        if not paths[name]:
            raise AudioError(f"Required offline audio tool is missing: {name}")
    if not Path(paths["dictionary"]).is_dir() or not Path(paths["voice"]).is_file():
        raise AudioError("Open JTalk dictionary or Nitech voice is missing; install the documented Ubuntu packages or set OPEN_JTALK_DIC and OPEN_JTALK_VOICE")
    return paths


def read_synthesis_trace(path: Path, wav: Path) -> list[tuple[str, float]]:
    """Read HTS's 100 ns labels and verify their clock against the native WAV.

    Nitech uses 48,000 samples/s and 240 samples/frame (5 ms), not 240 ms.
    The trace supplies both values so a changed or malformed clock fails closed.
    """
    if (path.is_symlink() or not path.is_file() or
            not 0 < path.stat().st_size <= MAX_TRACE_BYTES):
        raise AudioError("Missing or oversized Open JTalk synthesis trace")
    try:
        trace = path.read_text(encoding="utf-8")
        global_block = trace.split("[Global parameter]\n", 1)[1].split("\n\n", 1)[0]
        rate = int(re.search(r"(?:Sampling|Sampring) frequency\s+->\s+(\d+)\(Hz\)", global_block)[1])
        period = int(re.search(r"Frame period\s+->\s+(\d+)\(point\)", global_block)[1])
        milliseconds = float(re.search(r"([0-9.]+)\(msec\)", global_block)[1])
        labels = trace.split("[Output label]\n", 1)[1].split("\n\n", 1)[0].splitlines()
        hmm_count = int(re.search(r"Number of HMMs\s+->\s+(\d+)", trace)[1])
        with wave.open(str(wav), "rb") as source:
            wav_rate, wav_frames = source.getframerate(), source.getnframes()
    except (IndexError, TypeError, ValueError, UnicodeError, OSError, wave.Error, EOFError) as exc:
        raise AudioError("Invalid Open JTalk synthesis trace") from exc
    if (not 8000 <= rate <= 96000 or rate != wav_rate or
            not 0.001 <= period / rate <= 0.02 or
            not math.isclose(milliseconds, 1000 * period / rate, abs_tol=0.00001) or
            not 0 < len(labels) == hmm_count <= MAX_TRACE_LABELS):
        raise AudioError("Open JTalk trace has an invalid sample/frame clock or label count")
    phonemes = []
    previous = 0
    for line in labels:
        match = re.fullmatch(r"(\d+) (\d+) ([^\s]+)", line)
        if not match:
            raise AudioError("Invalid Open JTalk phoneme label")
        start, end = int(match[1]), int(match[2])
        phone = re.match(r"[^\s^]+\^[^\s-]+-([A-Za-z]+)\+[^\s]+", match[3])
        if (not phone or start != previous or end <= start or
                (end - start) * rate % (period * TRACE_TICKS_PER_SECOND)):
            raise AudioError("Invalid Open JTalk phoneme boundary")
        phonemes.append((phone[1], (end - start) / TRACE_TICKS_PER_SECOND))
        previous = end
    if (previous * rate != wav_frames * TRACE_TICKS_PER_SECOND or
            not any(phone not in ("sil", "pau") for phone, _ in phonemes)):
        raise AudioError("Open JTalk trace does not cover its synthesized WAV")
    return phonemes


def slow_phoneme_run(phonemes: list[tuple[str, float]]) -> int:
    """Ignore real pauses and isolated long vowels; detect sustained stretching."""
    run = maximum = 0
    for phone, seconds in phonemes:
        run = run + 1 if phone not in ("sil", "pau") and seconds > SLOW_PHONEME_SECONDS else 0
        maximum = max(maximum, run)
    return maximum


def split_slow_chunk(text: str) -> tuple[str, str]:
    """Split near half the UTF-8 bytes without changing text or splitting tokens."""
    total = len(text.encode("utf-8"))
    offsets = [(index, size) for index, size in safe_split_offsets(text)
               if index < len(text) and text[:index].strip() and text[index:].strip()]
    if not offsets:
        raise AudioError("Abnormally slow speech cannot be split further")
    for separators, low, high in (("。！？!?、，,；;：:", 0.30, 0.70),
                                  ("はがをにでとのもへや", 0.25, 0.75)):
        candidates = [(index, offset) for index, offset in offsets
                      if low * total <= offset <= high * total and text[index - 1] in separators]
        if candidates:
            cut = min(candidates, key=lambda item: abs(item[1] - total / 2))[0]
            break
    else:
        cut = min(offsets, key=lambda item: abs(item[1] - total / 2))[0]
    return text[:cut], text[cut:]


def split_short_numeric_expression(text: str) -> tuple[str, str] | None:
    """A short formula can expand into many accent phrases; split only operators.

    Ordinary short utterances retain the minimum-byte guard. Complete numeric
    operands on both sides ensure a repair never separates a decimal/percent.
    """
    if not NUMERIC_EXPRESSION.fullmatch(text):
        return None
    total = len(text.encode("utf-8"))
    candidates = [(index, size) for index, size in safe_split_offsets(text)
                  if text[index - 1] in MATH_OPERATORS and
                  re.search(r"[0-9]", text[index:])]
    if not candidates:
        return None
    cut = min(candidates, key=lambda item: abs(item[1] - total / 2))[0]
    return text[:cut], text[cut:]


def synthesize_chunk(text: str, temporary: Path, tools: dict[str, str]) -> list[dict]:
    """Retain normal PCM; repair only verified slow chunks with bounded retries."""
    if not text.strip() or "\n" in text or "\r" in text or len(text.encode("utf-8")) > MAX_INPUT_BYTES:
        raise AudioError("Open JTalk synthesis chunk must be a bounded nonempty input line")
    wav, trace = temporary / "chunk.wav", temporary / "chunk.txt"
    calls = 0

    def synthesize(part: str, depth: int) -> list[dict]:
        nonlocal calls
        if calls >= MAX_SYNTHESIS_CALLS:
            raise AudioError("Abnormally slow speech exceeded the bounded synthesis retry limit")
        calls += 1
        # A successful process that omitted an output must not reuse stale data.
        wav.unlink(missing_ok=True)
        trace.unlink(missing_ok=True)
        command([tools["open_jtalk"], "-x", tools["dictionary"], "-m", tools["voice"],
                 "-r", "1.0", "-ow", str(wav), "-ot", str(trace)], input_text=part + "\n")
        phonemes = read_synthesis_trace(trace, wav)
        # Reject malformed PCM even when its labels would request a retry.
        rate, pcm = bounded_pcm(wav, leading_pause=0, trailing_pause=0)
        if slow_phoneme_run(phonemes) < SLOW_PHONEME_RUN:
            return [{"text": part, "rate": rate, "pcm": pcm, "phonemes": phonemes}]
        if depth >= MAX_REPAIR_DEPTH:
            raise AudioError("Abnormally slow speech remains at the bounded minimum chunk size/depth")
        if len(part.encode("utf-8")) <= MIN_REPAIR_BYTES:
            split = split_short_numeric_expression(part)
            if split is None:
                raise AudioError("Abnormally slow speech remains at the bounded minimum chunk size/depth")
            left, right = split
        else:
            left, right = split_slow_chunk(part)
        return synthesize(left, depth + 1) + synthesize(right, depth + 1)

    return synthesize(text, 0)


def synthesize_article(article: dict, output: Path, tools: dict[str, str]) -> list[dict]:
    # Preserve the voice's native sample rate/frame period; ffmpeg resamples later.
    # Its CLI reads one line and truncates beyond its input buffer. Merge short
    # utterances into one article PCM, never independently encoded MP3 fragments.
    with tempfile.TemporaryDirectory(prefix="jtalk-article-") as temporary:
        temporary = Path(temporary)
        rate = None
        cursor = 0
        cues = []
        segments = speech_segments(article)
        if not segments:
            raise AudioError("Article has no speakable text")
        # Open the writer only after the first accepted PCM supplies its rate.
        # Otherwise wave.close() masks an early synthesis failure with a header error.
        with ExitStack() as stack:
            for index, segment in enumerate(segments):
                start = cursor
                # Never combine separate visual units into a synthesis chunk: a
                # paragraph boundary must come from PCM, not a text-length ratio.
                chunks = speech_chunks(segment["spoken"])
                for chunk_index, chunk in enumerate(chunks):
                    leaves = synthesize_chunk(chunk, temporary, tools)
                    for leaf_index, leaf in enumerate(leaves):
                        sample_rate, pcm = leaf["rate"], leaf["pcm"]
                        last = (index == len(segments) - 1 and chunk_index == len(chunks) - 1 and
                                leaf_index == len(leaves) - 1)
                        lead = round(sample_rate * LEADING_PAUSE_SECONDS) if cursor == 0 else 0
                        tail = round(sample_rate * (TRAILING_PAUSE_SECONDS if last else CHUNK_PAUSE_SECONDS))
                        pcm = b"\0\0" * lead + pcm + b"\0\0" * tail
                        if rate is None:
                            rate = sample_rate
                            joined = stack.enter_context(wave.open(str(output), "wb"))
                            joined.setnchannels(1)
                            joined.setsampwidth(2)
                            joined.setframerate(rate)
                        elif rate != sample_rate:
                            raise AudioError("Synthesized utterance sample rates differ")
                        if cursor + len(pcm) // 2 > rate * MAX_ARTICLE_SECONDS:
                            raise AudioError("Synthesized article exceeds the PCM duration limit")
                        joined.writeframesraw(pcm)
                        cursor += len(pcm) // 2
                cues.append({"key": segment["key"], "text": segment["text"],
                             "startFrame": start, "endFrame": cursor})
        return cues


def bounded_pcm(path: Path, *, leading_pause: float = LEADING_PAUSE_SECONDS,
                trailing_pause: float = TRAILING_PAUSE_SECONDS) -> tuple[int, bytes]:
    """Replace synthesizer edge silence with exact, bounded chapter pauses."""
    try:
        with wave.open(str(path), "rb") as source:
            rate = source.getframerate()
            frames = source.getnframes()
            if (source.getnchannels() != 1 or source.getsampwidth() != 2 or
                    source.getcomptype() != "NONE" or not 8000 <= rate <= 96000 or
                    not 0 < frames <= rate * MAX_ARTICLE_SECONDS):
                raise AudioError("Invalid or oversized synthesized PCM audio")
            raw = source.readframes(frames)
    except (wave.Error, EOFError) as exc:
        raise AudioError("Invalid synthesized WAV") from exc
    if len(raw) != frames * 2:
        raise AudioError("Truncated synthesized PCM audio")
    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    first = next((index for index, value in enumerate(samples) if abs(value) > 80), None)
    if first is None:
        raise AudioError("Synthesizer produced silent audio")
    last = len(samples) - next(index for index, value in enumerate(reversed(samples)) if abs(value) > 80)
    lead = round(rate * leading_pause)
    tail = round(rate * trailing_pause)
    return rate, b"\0\0" * lead + raw[first * 2:last * 2] + b"\0\0" * tail


def concatenate_articles(articles: list[dict], wavs: list[Path], output: Path,
                         cue_frames: list[list[dict]] | None = None) -> tuple[list[dict], float]:
    """Chapter starts/ends count WAV frames, including the bounded pauses."""
    chapters = []
    cursor = 0
    rate = None
    with wave.open(str(output), "wb") as joined:
        joined.setnchannels(1)
        joined.setsampwidth(2)
        if cue_frames is not None and len(cue_frames) != len(articles):
            raise AudioError("Measured cues are required for every article")
        for index, (article, wav) in enumerate(zip(articles, wavs, strict=True)):
            sample_rate, pcm = bounded_pcm(wav)
            if rate is None:
                rate = sample_rate
                joined.setframerate(rate)
            elif rate != sample_rate:
                raise AudioError("Synthesized article sample rates differ")
            end = cursor + len(pcm) // 2
            chapter = {"id": article["id"], "title": article["title"],
                       "start": cursor / rate, "end": end / rate,
                       "articleHash": article_hash(article)}
            if cue_frames is not None:
                measured = cue_frames[index]
                expected = speech_segments(article)
                if not isinstance(measured, list) or len(measured) != len(expected) or not measured:
                    raise AudioError("Measured cues do not match the spoken article")
                local_cursor = 0
                cues = []
                for cue, segment in zip(measured, expected, strict=True):
                    if (not isinstance(cue, dict) or cue.get("key") != segment["key"] or
                            cue.get("text") != segment["text"] or
                            type(cue.get("startFrame")) is not int or
                            type(cue.get("endFrame")) is not int or
                            cue["startFrame"] != local_cursor or
                            not local_cursor < cue["endFrame"] <= len(pcm) // 2):
                        raise AudioError("Invalid measured cue boundary or text")
                    cues.append({"key": cue["key"], "text": cue["text"],
                                 "start": (cursor + local_cursor) / rate,
                                 "end": (cursor + cue["endFrame"]) / rate})
                    local_cursor = cue["endFrame"]
                if local_cursor != len(pcm) // 2:
                    raise AudioError("Measured cues do not cover the complete article PCM")
                chapter["cues"] = cues
            chapters.append(chapter)
            joined.writeframesraw(pcm)
            cursor = end
    return chapters, cursor / rate


def encode_mp3(wav: Path, output: Path, date: str, tools: dict[str, str]) -> None:
    attribution = (f"Voice: {VOICE['name']}; {VOICE['credit']}; "
                   f"License: {VOICE['licenseTitle']} {VOICE['licenseUrl']}; Source: {VOICE['sourceUrl']}")
    command([tools["ffmpeg"], "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
             "-i", str(wav), "-map_metadata", "-1", "-vn", "-c:a", "libmp3lame",
             "-ar", "24000", "-ac", "1", "-b:a", "48k", "-id3v2_version", "3",
             "-write_id3v1", "0", "-metadata", f"title={date} 朝の3本",
             "-metadata", f"artist={VOICE['credit']}", "-metadata", f"comment={attribution}",
             "-metadata", f"copyright={VOICE['licenseTitle']} {VOICE['licenseUrl']}",
             "-metadata", f"voice={VOICE['name']}", "-metadata", f"license={VOICE['licenseUrl']}",
             str(output)])


def validate_mp3(path: Path, expected_duration: float, tools: dict[str, str]) -> None:
    report = json.loads(command([tools["ffprobe"], "-v", "error", "-show_streams", "-show_format",
                                 "-of", "json", str(path)]))
    streams = report.get("streams", [])
    try:
        duration = float(report["format"]["duration"])
    except (KeyError, TypeError, ValueError) as exc:
        raise AudioError("Encoded MP3 has no valid duration") from exc
    tags = report.get("format", {}).get("tags", {})
    if (len(streams) != 1 or streams[0].get("codec_name") != "mp3" or
            streams[0].get("channels") != 1 or not math.isfinite(duration) or
            abs(duration - expected_duration) > 0.15 or path.stat().st_size == 0 or
            tags.get("artist") != VOICE["credit"] or
            VOICE["name"] not in tags.get("comment", "") or
            tags.get("voice", VOICE["name"]) != VOICE["name"] or
            VOICE["licenseUrl"] not in tags.get("comment", "") or
            VOICE["sourceUrl"] not in tags.get("comment", "")):
        raise AudioError("Encoded MP3 failed format, duration, or attribution validation")
    # Decode the complete file, so a readable header cannot conceal a damaged tail.
    command([tools["ffmpeg"], "-v", "error", "-xerror", "-nostdin", "-i", str(path), "-f", "null", "-"])


class RejectArchiveRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise AudioError("Published audio redirects are not allowed")


def open_published_url(url: str):
    request = urllib.request.Request(url, headers={"Accept-Encoding": "identity",
                                                 "Cache-Control": "no-cache",
                                                 "User-Agent": "ai-daily-audio-archive/1"})
    return urllib.request.build_opener(RejectArchiveRedirects).open(request, timeout=30)


def download_published(url: str, destination: Path, maximum: int) -> int:
    """Download bounded HTTPS bytes; only transient failures receive retries."""
    if maximum <= 0:
        raise AudioError("Published audio exceeds the publication byte limit")
    if urllib.parse.urlsplit(url).scheme != "https":
        raise AudioError("Published audio downloads require HTTPS")
    for attempt in range(ARCHIVE_DOWNLOAD_ATTEMPTS):
        complete = False
        try:
            with open_published_url(url) as response, destination.open("wb") as output:
                if response.geturl() != url or response.getcode() != 200:
                    raise AudioError("Published audio returned an unexpected URL or HTTP status")
                if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                    raise AudioError("Published audio must use an uncompressed HTTP response")
                length = response.headers.get("Content-Length")
                if length is not None and (not length.isdecimal() or not 0 < int(length) <= maximum):
                    raise AudioError("Published audio has an invalid or oversized Content-Length")
                size = 0
                while block := response.read(min(64 * 1024, maximum - size + 1)):
                    size += len(block)
                    if size > maximum:
                        raise AudioError("Published audio exceeds the download byte limit")
                    output.write(block)
                if size == 0 or (length is not None and size != int(length)):
                    raise AudioError("Published audio download was empty or truncated")
                complete = True
                return size
        except urllib.error.HTTPError as exc:
            if exc.code not in (408, 429, 500, 502, 503, 504):
                raise AudioError(f"Published audio download rejected: HTTP {exc.code}") from exc
            failure = exc
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.IncompleteRead) as exc:
            failure = exc
        finally:
            # A partial download can never be mistaken for a successful archive.
            if not complete:
                destination.unlink(missing_ok=True)
        if attempt + 1 < ARCHIVE_DOWNLOAD_ATTEMPTS:
            destination.unlink(missing_ok=True)
            time.sleep(0.5 * 2 ** attempt)
    destination.unlink(missing_ok=True)
    raise AudioError("Published audio download failed after bounded retries") from failure


def trusted_archive_url(url: str, project_root: Path) -> str:
    """Only the configured site's canonical HTTPS audio manifest is trusted."""
    try:
        base = json.loads((project_root / "site.json").read_text(encoding="utf-8"))["baseUrl"]
        if not isinstance(base, str):
            raise ValueError()
        parsed = urllib.parse.urlsplit(base)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or
                parsed.query or parsed.fragment or not parsed.path.endswith("/") or parsed.port not in (None, 443)):
            raise ValueError()
        expected = urllib.parse.urljoin(base, "audio/index.json")
        if url != expected:
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise AudioError("Published archive must be the configured site's canonical HTTPS audio/index.json") from exc
    return expected


def archive_number(value: object) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def validate_archive_day(date: str, entry: object, source: dict | None) -> None:
    try:
        if dt.date.fromisoformat(date).isoformat() != date:
            raise ValueError()
    except (TypeError, ValueError) as exc:
        raise AudioError("Published archive has an invalid edition date") from exc
    if not isinstance(entry, dict):
        raise AudioError(f"Invalid published audio edition: {date}")
    digest, filename, duration = entry.get("sha256"), entry.get("url"), entry.get("duration")
    if (not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest) or
            not isinstance(filename, str) or not MP3_FILE.fullmatch(filename) or
            filename != f"{date}-{digest[:12]}.mp3" or not archive_number(duration) or
            not 0 < duration <= 3 * MAX_ARTICLE_SECONDS):
        raise AudioError(f"Invalid published audio URL, digest, or duration: {date}")
    articles = entry.get("articles")
    if not isinstance(articles, list) or len(articles) != 3:
        raise AudioError(f"Published audio requires exactly three chapters: {date}")
    cursor = 0
    for index, chapter in enumerate(articles):
        if (not isinstance(chapter, dict) or chapter.get("id") != f"{date}-{index + 1}" or
                not isinstance(chapter.get("articleHash"), str) or
                not re.fullmatch(r"[a-f0-9]{64}", chapter["articleHash"]) or
                not isinstance(chapter.get("title"), str) or not chapter["title"].strip() or
                not archive_number(chapter.get("start")) or not archive_number(chapter.get("end")) or
                abs(chapter["start"] - cursor) > .001 or
                not 0 <= chapter["start"] < chapter["end"] <= duration + .001):
            raise AudioError(f"Invalid published audio chapter: {date}")
        article = source["articles"][index] if source else None
        if article and (chapter["title"] != article["title"] or chapter["articleHash"] != article_hash(article)):
            raise AudioError(f"Published audio source mismatch; refusing to regenerate {article['id']}")
        cues = chapter.get("cues")
        if "cues" in chapter:
            if not isinstance(cues, list):
                raise AudioError(f"Invalid published audio cues: {date}")
            expected = speech_segments(article) if article else None
            if cues and expected is not None and len(cues) != len(expected):
                raise AudioError(f"Published audio cue text does not match its source: {date}")
            cue_cursor = chapter["start"]
            for cue_index, cue in enumerate(cues):
                if (not isinstance(cue, dict) or not isinstance(cue.get("key"), str) or
                        not isinstance(cue.get("text"), str) or
                        not archive_number(cue.get("start")) or not archive_number(cue.get("end")) or
                        abs(cue["start"] - cue_cursor) > .001 or
                        not chapter["start"] <= cue["start"] < cue["end"] <= chapter["end"] + .001 or
                        (expected is not None and (cue["key"] != expected[cue_index]["key"] or
                                                  cue["text"] != expected[cue_index]["text"]))):
                    raise AudioError(f"Invalid published audio cue boundary or text: {date}")
                cue_cursor = cue["end"]
            if cues and abs(cue_cursor - chapter["end"]) > .001:
                raise AudioError(f"Published audio cues do not cover their chapter: {date}")
        cursor = chapter["end"]
    if abs(cursor - duration) > .001:
        raise AudioError(f"Published audio chapters do not cover their edition: {date}")


def load_published_archive(url: str, days: list[dict], project_root: Path, temporary: Path) -> dict:
    url = trusted_archive_url(url, project_root)
    path = temporary / "published-index.json"
    download_published(url, path, MAX_ARCHIVE_MANIFEST_BYTES)

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise AudioError("Published audio manifest contains duplicate JSON keys")
            result[key] = value
        return result

    def invalid_constant(value):
        raise AudioError("Non-finite published JSON number")

    try:
        manifest = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object,
                              parse_constant=invalid_constant)
    except (ValueError, UnicodeError) as exc:
        raise AudioError("Invalid published audio manifest JSON") from exc
    if (not isinstance(manifest, dict) or type(manifest.get("version")) is not int or manifest["version"] != 1 or
            manifest.get("voice") != VOICE or not isinstance(manifest.get("days"), dict) or
            not 0 < len(manifest["days"]) <= MAX_DAYS):
        raise AudioError("Published audio manifest has an invalid version, voice, or edition count")
    sources = {day["date"]: day for day in days}
    for date, entry in manifest["days"].items():
        validate_archive_day(date, entry, sources.get(date))
    last_published = max(manifest["days"])
    if any(day["date"] not in manifest["days"] and day["date"] <= last_published for day in days):
        raise AudioError("An older source edition is absent from the published archive; refusing to regenerate it")
    return manifest["days"]


def build_audio(output: Path, project_root: Path = ROOT, *, published_archive: str | None = None) -> dict:
    project_root = project_root.resolve()
    output = Path(output)
    if not output.is_absolute():
        output = project_root / output
    if output.is_symlink() or not output.is_dir():
        raise AudioError("Build the static site before generating audio")
    output = output.resolve()
    if not output.is_relative_to(project_root) or output == project_root:
        raise AudioError("Audio output must be inside the project's built site")
    days = load_days(project_root)
    tools = toolchain()
    audio = output / "audio"
    if audio.is_symlink():
        raise AudioError("Audio output must not be a symlink")
    audio.mkdir(exist_ok=True)
    for path in audio.iterdir():
        if path.is_symlink() or not path.is_file() or not (path.name == "index.json" or MP3_FILE.fullmatch(path.name)):
            raise AudioError(f"Unexpected file in generated audio directory: {path.name}")
    manifest = {"version": 1, "voice": dict(VOICE), "days": {}}
    staged = []
    total_bytes = 0
    # This directory is deleted on either success or failure and never published.
    with tempfile.TemporaryDirectory(prefix="daily-audio-") as temporary:
        temporary = Path(temporary)
        published = (load_published_archive(published_archive, days, project_root, temporary)
                     if published_archive is not None else {})
        for day in days:
            if day["date"] in published:
                entry = published[day["date"]]
                mp3 = temporary / entry["url"]
                url = urllib.parse.urljoin(published_archive, entry["url"])
                total_bytes += download_published(url, mp3, MAX_OUTPUT_BYTES - total_bytes)
                if hashlib.sha256(mp3.read_bytes()).hexdigest() != entry["sha256"]:
                    raise AudioError(f"Published MP3 digest mismatch: {day['date']}")
                validate_mp3(mp3, entry["duration"], tools)
                staged.append((mp3, entry["url"]))
                # Preserve every chapter/cue and other edition metadata verbatim.
                manifest["days"][day["date"]] = entry
                print(f"audio: {day['date']}: reused published bytes and metadata", flush=True)
                continue
            wavs = []
            cue_frames = []
            for article in day["articles"]:
                wav = temporary / f"{article['id']}.wav"
                cue_frames.append(synthesize_article(article, wav, tools))
                wavs.append(wav)
            joined = temporary / "joined.wav"
            chapters, duration = concatenate_articles(day["articles"], wavs, joined, cue_frames)
            mp3 = temporary / f"{day['date']}.mp3"
            encode_mp3(joined, mp3, day["date"], tools)
            validate_mp3(mp3, duration, tools)
            digest = hashlib.sha256(mp3.read_bytes()).hexdigest()
            filename = f"{day['date']}-{digest[:12]}.mp3"
            total_bytes += mp3.stat().st_size
            if total_bytes > MAX_OUTPUT_BYTES:
                raise AudioError("Generated audio exceeds the 64 MiB publication limit")
            staged.append((mp3, filename))
            manifest["days"][day["date"]] = {"url": filename, "duration": duration,
                                                "sha256": digest, "articles": chapters}
            # Keep peak temporary storage to one edition's PCM plus finished MP3s.
            for wav in [*wavs, joined]:
                wav.unlink()
            print(f"audio: {day['date']}: {duration:.2f}s, {mp3.stat().st_size} bytes", flush=True)
        encoded_manifest = (compact_json(manifest) + "\n").encode("utf-8")
        if total_bytes + len(encoded_manifest) > MAX_OUTPUT_BYTES:
            raise AudioError("Generated audio and manifest exceed the 64 MiB publication limit")
        # All MP3s have passed probing and decoding before the manifest is replaced.
        for source, filename in staged:
            destination = audio / filename
            with tempfile.NamedTemporaryFile(dir=audio, prefix=".mp3-", delete=False) as pending:
                pending_path = Path(pending.name)
                try:
                    with source.open("rb") as src:
                        shutil.copyfileobj(src, pending)
                    pending.flush()
                    os.fsync(pending.fileno())
                    os.chmod(pending_path, 0o644)
                    os.replace(pending_path, destination)
                finally:
                    pending_path.unlink(missing_ok=True)
        with tempfile.NamedTemporaryFile(dir=audio, prefix=".index-", delete=False) as pending:
            pending_path = Path(pending.name)
            try:
                pending.write(encoded_manifest)
                pending.flush()
                os.fsync(pending.fileno())
                os.chmod(pending_path, 0o644)
                os.replace(pending_path, audio / "index.json")
            finally:
                pending_path.unlink(missing_ok=True)
        keep = {filename for _, filename in staged}
        for path in audio.iterdir():
            if MP3_FILE.fullmatch(path.name) and path.name not in keep:
                path.unlink()
    return {"days": len(days), "articles": len(days) * 3,
            "bytes": total_bytes + len(encoded_manifest), "output": str(audio)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Existing static build directory, e.g. dist")
    parser.add_argument("--reuse-published", metavar="HTTPS_MANIFEST_URL",
                        help="Reuse verified published MP3 bytes/metadata; synthesize only newer unpublished editions")
    args = parser.parse_args()
    try:
        print(compact_json(build_audio(args.output, published_archive=args.reuse_published)))
    except (AudioError, OSError, json.JSONDecodeError) as exc:
        print(f"audio: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
