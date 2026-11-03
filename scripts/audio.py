#!/usr/bin/env python3
"""Generate attributed, offline Japanese MP3 editions from public article JSON.

Ubuntu dependencies: open-jtalk open-jtalk-mecab-naist-jdic
hts-voice-nitech-jp-atr503-m001 ffmpeg. No network access or API is used here.
"""

from __future__ import annotations

import argparse
import array
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import wave


ROOT = Path(__file__).resolve().parent.parent
MAX_DAYS = 14
MAX_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_ARTICLE_SECONDS = 1800
MAX_INPUT_BYTES = 300
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


def speech_chunks(text: str) -> list[str]:
    """Stay below the CLI's byte buffer, preferring sentence/phrase boundaries."""
    remaining = re.sub(r"\s+", " ", text).strip()
    chunks = []
    while remaining:
        byte_count = 0
        end = 0
        for char in remaining:
            size = len(char.encode("utf-8"))
            if byte_count + size > MAX_INPUT_BYTES:
                break
            byte_count += size
            end += 1
        if end < len(remaining):
            # Retain punctuation and all content, even in unusually long sentences.
            boundaries = [index + 1 for index, char in enumerate(remaining[:end])
                          if char in "。！？!?、，, "]
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


def synthesize_article(article: dict, output: Path, tools: dict[str, str]) -> list[dict]:
    # Preserve the voice's native sample rate/frame period; ffmpeg resamples later.
    # Its CLI reads one line and truncates beyond its input buffer. Merge short
    # utterances into one article PCM, never independently encoded MP3 fragments.
    with tempfile.TemporaryDirectory(prefix="jtalk-article-") as temporary:
        chunk_wav = Path(temporary) / "chunk.wav"
        rate = None
        cursor = 0
        cues = []
        segments = speech_segments(article)
        if not segments:
            raise AudioError("Article has no speakable text")
        with wave.open(str(output), "wb") as joined:
            joined.setnchannels(1)
            joined.setsampwidth(2)
            for index, segment in enumerate(segments):
                start = cursor
                # Never combine separate visual units into a synthesis chunk: a
                # paragraph boundary must come from PCM, not a text-length ratio.
                chunks = speech_chunks(segment["spoken"])
                for chunk_index, chunk in enumerate(chunks):
                    command([tools["open_jtalk"], "-x", tools["dictionary"], "-m", tools["voice"],
                             "-r", "1.0", "-ow", str(chunk_wav)], input_text=chunk + "\n")
                    last = index == len(segments) - 1 and chunk_index == len(chunks) - 1
                    sample_rate, pcm = bounded_pcm(
                        chunk_wav, leading_pause=LEADING_PAUSE_SECONDS if cursor == 0 else 0,
                        trailing_pause=TRAILING_PAUSE_SECONDS if last else CHUNK_PAUSE_SECONDS)
                    if rate is None:
                        rate = sample_rate
                        joined.setframerate(rate)
                    elif rate != sample_rate:
                        raise AudioError("Synthesized utterance sample rates differ")
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
            VOICE["licenseUrl"] not in tags.get("comment", "") or
            VOICE["sourceUrl"] not in tags.get("comment", "")):
        raise AudioError("Encoded MP3 failed format, duration, or attribution validation")
    # Decode the complete file, so a readable header cannot conceal a damaged tail.
    command([tools["ffmpeg"], "-v", "error", "-xerror", "-nostdin", "-i", str(path), "-f", "null", "-"])


def build_audio(output: Path, project_root: Path = ROOT) -> dict:
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
        for day in days:
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
    args = parser.parse_args()
    try:
        print(compact_json(build_audio(args.output)))
    except (AudioError, OSError, json.JSONDecodeError) as exc:
        print(f"audio: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
