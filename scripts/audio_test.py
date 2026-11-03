#!/usr/bin/env python3
"""Audio contract checks; the integration case uses local ffmpeg, no network."""

import contextlib
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import wave

import audio


def article(date="2026-11-03", index=1):
    return {"id": f"{date}-{index}", "title": "日本語の見出し 📻 \"引用\"",
            "body": "一段目。\\記号\n\n二段目。 https://example.test/a/b",
            "reading": {"sections": [{"heading": "はじめに", "start": 0},
                                     {"heading": "次の段落", "start": 1}],
                        "action": "ひとつ、試す。",
                        "hook": "読まない導入", "takeaways": ["重複させない要点"],
                        "figures": [{"credit": "読まない図版クレジット"}]},
            "sources": [{"title": "読まない出典", "url": "https://example.test/source"}]}


def edition(date="2026-11-03"):
    return {"date": date, "articles": [article(date, index) for index in range(1, 4)]}


def write_wav(path, frames=800, rate=8000, padding=300):
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        signal = (struct.pack("<hh", 5000, -5000) * ((frames + 1) // 2))[:frames * 2]
        wav.writeframes(b"\0\0" * padding + signal + b"\0\0" * padding)


class ArticleContractTest(unittest.TestCase):
    def test_hash_matches_javascript_stringify_unicode_fixture(self):
        # Generated with Node createHash('sha256').update(JSON.stringify([...])).
        expected = "4fe086d2f55f2b46e017b71b57b218f5fda4603e0354a04e2a6e72f2229e12f3"
        self.assertEqual(audio.article_hash(article()), expected)
        changed = article()
        changed["reading"]["figures"][0]["credit"] = "異なる図版の帰属"
        self.assertEqual(audio.article_hash(changed), expected)
        changed["reading"]["sections"][1]["heading"] = "本文の見出しの変更"
        self.assertNotEqual(audio.article_hash(changed), expected)

    @unittest.skipUnless(shutil.which("node"), "Node is needed for cross-language hash verification")
    def test_public_articles_have_same_hash_in_python_and_player_algorithm(self):
        articles = [item for day in audio.load_days(audio.ROOT) for item in day["articles"]]
        js = """const {createHash}=require('node:crypto');let s='';
process.stdin.setEncoding('utf8');process.stdin.on('data',d=>s+=d);
process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(a=>
createHash('sha256').update(JSON.stringify([a.id,a.title,a.body,
(a.reading?.sections||[]).map(s=>[s.heading,s.start]),a.reading?.action||''])).digest('hex')))));"""
        actual = subprocess.run(["node", "-e", js], input=json.dumps(articles, ensure_ascii=False),
                                text=True, capture_output=True, check=True)
        self.assertEqual([audio.article_hash(item) for item in articles], json.loads(actual.stdout))

    def test_speech_order_and_omitted_visuals_sources_and_duplicate_takeaways(self):
        spoken = audio.speech_text(article())
        chunks = ["日本語の見出し", "はじめに", "一段目", "次の段落", "二段目", "ひとつ、試してみる", "ひとつ、試す"]
        positions = [spoken.index(chunk) for chunk in chunks]
        self.assertEqual(positions, sorted(positions))
        for omitted in ["読まない", "重複させない", "https://", "example.test"]:
            self.assertNotIn(omitted, spoken)
        self.assertEqual(spoken.count("ひとつ、試す"), 1)
        self.assertEqual(spoken.count("\n"), 1, "Open JTalk CLI consumes only its first input line")

    def test_utterance_chunks_preserve_all_text_below_cli_byte_buffer(self):
        source = audio.speech_text(article()) + "非常に長い文。" * 300 + "区切りのない文" * 300
        chunks = audio.speech_chunks(source)
        self.assertGreater(len(chunks), 10)
        self.assertTrue(all(len(chunk.encode("utf-8")) <= 300 for chunk in chunks))
        self.assertTrue(all("\n" not in chunk for chunk in chunks))
        self.assertEqual("".join("".join(chunks).split()), "".join(source.split()))

    def test_malformed_dates_ids_and_sections_fail(self):
        bad_days = []
        bad = edition(); bad["date"] = "2026-02-30"; bad_days.append(bad)
        bad = edition(); bad["articles"][1]["id"] = "../../private"; bad_days.append(bad)
        bad = edition(); bad["articles"][0]["body"] = ""; bad_days.append(bad)
        bad = edition(); bad["articles"][0]["reading"]["sections"][1]["start"] = True; bad_days.append(bad)
        bad = edition(); bad["articles"][0]["reading"]["sections"][1]["start"] = 2; bad_days.append(bad)
        bad = edition(); bad["articles"][0]["reading"]["sections"][0]["start"] = 1; bad_days.append(bad)
        for bad in bad_days:
            with self.subTest(bad=bad), self.assertRaises(audio.AudioError):
                audio.validate_day(bad, bad["date"] + ".json")
        with self.assertRaises(audio.AudioError):
            audio.validate_day(edition(), "2026-11-02.json")

    def test_latest_fourteen_only_and_no_private_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "content").mkdir()
            for index in range(1, 16):
                date = f"2026-10-{index:02d}"
                (root / "content" / f"{date}.json").write_text(json.dumps(edition(date)), encoding="utf-8")
            (root / "content" / "2026-10-16.private.json").write_text("this is not public JSON")
            days = audio.load_days(root)
            self.assertEqual(len(days), 14)
            self.assertEqual(days[0]["date"], "2026-10-02")
            self.assertEqual(days[-1]["date"], "2026-10-15")
            (root / "content" / "2026-10-01.json").write_text("{}")
            with self.assertRaises(audio.AudioError):
                audio.load_days(root)

    def test_public_edition_symlink_cannot_read_outside_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "content").mkdir()
            (root / "content" / "2026-11-03.json").symlink_to(root / "private.json")
            with self.assertRaises(audio.AudioError):
                audio.load_days(root)


class PcmContractTest(unittest.TestCase):
    def test_chapter_boundaries_match_exact_concatenated_wav_frames(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            counts = [800, 1201, 1600]
            paths = [root / f"{index}.wav" for index in range(3)]
            for path, count in zip(paths, counts):
                write_wav(path, count)
            joined = root / "joined.wav"
            chapters, duration = audio.concatenate_articles(edition()["articles"], paths, joined)
            pause_frames = round(8000 * audio.LEADING_PAUSE_SECONDS) + round(8000 * audio.TRAILING_PAUSE_SECONDS)
            expected_counts = [count + pause_frames for count in counts]
            cursor = 0
            for chapter, count in zip(chapters, expected_counts):
                self.assertEqual(chapter["start"], cursor / 8000)
                cursor += count
                self.assertEqual(chapter["end"], cursor / 8000)
            self.assertEqual(duration, cursor / 8000)
            with wave.open(str(joined), "rb") as source:
                self.assertEqual(source.getnframes(), cursor)
                self.assertEqual(source.getframerate(), 8000)
                raw = source.readframes(cursor)
            lead = round(8000 * audio.LEADING_PAUSE_SECONDS)
            self.assertEqual(raw[:lead * 2], b"\0\0" * lead)
            self.assertEqual(struct.unpack_from("<h", raw, lead * 2)[0], 5000)

    def test_silent_or_mismatched_pcm_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = [root / "a.wav", root / "b.wav", root / "c.wav"]
            for path, rate in zip(paths, [8000, 16000, 8000]):
                write_wav(path, rate=rate)
            with self.assertRaises(audio.AudioError):
                audio.concatenate_articles(edition()["articles"], paths, root / "joined.wav")
            with wave.open(str(paths[0]), "wb") as silence:
                silence.setnchannels(1); silence.setsampwidth(2); silence.setframerate(8000)
                silence.writeframes(b"\0\0" * 800)
            with self.assertRaises(audio.AudioError):
                audio.bounded_pcm(paths[0])


class OpenJtalkLengthTest(unittest.TestCase):
    def test_long_article_is_not_truncated_by_cli_line_or_byte_buffer(self):
        try:
            tools = audio.toolchain()
        except audio.AudioError as exc:
            self.skipTest(str(exc))
        with tempfile.TemporaryDirectory() as temporary:
            durations = []
            for count in [20, 80]:
                item = {"id": "2026-11-03-1", "title": "長文の確認", "body": "最後の文章です。" * count}
                path = Path(temporary) / f"{count}.wav"
                audio.synthesize_article(item, path, tools)
                with wave.open(str(path), "rb") as wav:
                    durations.append(wav.getnframes() / wav.getframerate())
            # An unsegmented 1.9 KB input is silently capped around 71 seconds;
            # correct synthesis scales with the full content (about fourfold).
            self.assertGreater(durations[1] / durations[0], 3.5)
            self.assertLess(durations[1] / durations[0], 4.5)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Local ffmpeg/ffprobe required")
class Mp3PublicationTest(unittest.TestCase):
    def make_project(self, root):
        (root / "content").mkdir()
        (root / "dist").mkdir()
        (root / "dist" / "index.html").write_text("existing page")
        for date in ["2026-11-01", "2026-11-02", "2026-11-03"]:
            (root / "content" / f"{date}.json").write_text(json.dumps(edition(date)), encoding="utf-8")
        audio_dir = root / "dist" / "audio"
        audio_dir.mkdir()
        (audio_dir / "index.json").write_text("previous manifest")
        (audio_dir / "2026-10-01-000000000000.mp3").write_bytes(b"previous audio")
        return audio_dir

    @staticmethod
    def fake_synthesis(item, output, tools):
        write_wav(output, frames=800 + int(item["id"][-1]) * 100)

    def test_real_encoder_file_hash_attribution_duration_and_latest_pruning(self):
        tools = {name: shutil.which(name) for name in ["ffmpeg", "ffprobe"]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio_dir = self.make_project(root)
            with patch.object(audio, "toolchain", return_value=tools), \
                    patch.object(audio, "synthesize_article", side_effect=self.fake_synthesis), \
                    patch.object(audio, "MAX_DAYS", 2), contextlib.redirect_stdout(io.StringIO()):
                result = audio.build_audio(root / "dist", root)
            manifest = json.loads((audio_dir / "index.json").read_text())
            self.assertEqual(result["days"], 2)
            self.assertEqual(list(manifest["days"]), ["2026-11-02", "2026-11-03"])
            self.assertEqual(manifest["voice"], audio.VOICE)
            self.assertEqual(len(list(audio_dir.iterdir())), 3)
            for date, day in manifest["days"].items():
                mp3 = audio_dir / day["url"]
                digest = hashlib.sha256(mp3.read_bytes()).hexdigest()
                self.assertEqual(day["sha256"], digest)
                self.assertEqual(day["url"], f"{date}-{digest[:12]}.mp3")
                self.assertEqual(day["articles"][0]["start"], 0)
                self.assertEqual(day["articles"][-1]["end"], day["duration"])
                for previous, following in zip(day["articles"], day["articles"][1:]):
                    self.assertEqual(previous["end"], following["start"])
                audio.validate_mp3(mp3, day["duration"], tools)
            actual_size = sum(path.stat().st_size for path in audio_dir.iterdir())
            self.assertEqual(result["bytes"], actual_size)
            self.assertLessEqual(actual_size, 64 * 1024 * 1024)
            self.assertEqual((root / "dist" / "index.html").read_text(), "existing page")

    def test_failed_generation_preserves_previous_manifest_and_audio(self):
        tools = {name: shutil.which(name) for name in ["ffmpeg", "ffprobe"]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio_dir = self.make_project(root)
            before = {path.name: path.read_bytes() for path in audio_dir.iterdir()}
            with patch.object(audio, "toolchain", return_value=tools), \
                    patch.object(audio, "synthesize_article", side_effect=self.fake_synthesis), \
                    patch.object(audio, "MAX_OUTPUT_BYTES", 1), \
                    self.assertRaises(audio.AudioError):
                audio.build_audio(root / "dist", root)
            self.assertEqual({path.name: path.read_bytes() for path in audio_dir.iterdir()}, before)


if __name__ == "__main__":
    unittest.main()
