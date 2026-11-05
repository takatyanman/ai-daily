#!/usr/bin/env python3
"""Audio contract checks; the integration case uses local ffmpeg, no network."""

import contextlib
import copy
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
import urllib.error
import wave

import audio

SYNTHESIZE_ARTICLE = audio.synthesize_article


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


def write_trace(path, phonemes, rate=8000, period=40):
    labels = []
    cursor = 0
    for phone, frames in phonemes:
        end = cursor + frames
        labels.append(f"{cursor * audio.TRACE_TICKS_PER_SECOND // rate} "
                      f"{end * audio.TRACE_TICKS_PER_SECOND // rate} "
                      f"xx^xx-{phone}+xx=xx/A:xx+xx+xx/F:1_1#0_xx@1_1|1_1")
        cursor = end
    path.write_text("[Output label]\n" + "\n".join(labels) +
                    f"\n\n[Global parameter]\nSampring frequency -> {rate}(Hz)\n"
                    f"Frame period -> {period}(point)\n{1000 * period / rate:.5f}(msec)\n\n"
                    f"[Generated sequence]\nNumber of HMMs -> {len(labels)}\n", encoding="utf-8")


def synthetic_jtalk(arguments, input_text, slow=False):
    phones = [("a", 2400)] * 5 if slow else [("a", 400)]
    frames = sum(frames for _, frames in phones)
    write_wav(Path(arguments[arguments.index("-ow") + 1]), frames=frames, padding=320)
    write_trace(Path(arguments[arguments.index("-ot") + 1]), [("sil", 320), *phones, ("sil", 320)])
    return ""


def measured_fixture(item, output, calls=None):
    """Exercise real segment assembly using known, unequal PCM utterance lengths."""
    if calls is None:
        calls = []

    def fake_jtalk(arguments, *, input_text=None, **kwargs):
        frames = 400 + len(calls) * 120
        calls.append({"text": input_text.strip(), "frames": frames})
        write_wav(Path(arguments[arguments.index("-ow") + 1]), frames=frames, padding=320)
        write_trace(Path(arguments[arguments.index("-ot") + 1]), [("sil", 320), ("a", frames), ("sil", 320)])
        return ""

    with patch.object(audio, "command", side_effect=fake_jtalk):
        return SYNTHESIZE_ARTICLE(item, output,
                                  {"open_jtalk": "fake-jtalk", "dictionary": "unused", "voice": "unused"})


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

    def test_initial_chunks_keep_formatted_numbers_and_latin_words_intact(self):
        for token in ("4,239", "1,000", "7.5％", "WACC"):
            for padding in (98, 99, 100):
                source = "あ" * padding + token + "の意味を確認します。"
                with self.subTest(token=token, padding=padding):
                    chunks = audio.speech_chunks(source)
                    self.assertEqual("".join(chunks), source)
                    self.assertTrue(any(token in chunk for chunk in chunks))
                    self.assertTrue(all(len(chunk.encode()) <= audio.MAX_INPUT_BYTES for chunk in chunks))
        with self.assertRaises(audio.AudioError):
            audio.speech_chunks("A" * (audio.MAX_INPUT_BYTES + 1))

    def test_segment_keys_use_body_paragraph_indexes_and_keep_public_display_text(self):
        item = article()
        item["body"] = "最初の段落。\n\n途中の段落。\n\n最後の段落。"
        item["reading"]["sections"][1]["start"] = 2
        segments = audio.speech_segments(item)
        self.assertEqual([segment["key"] for segment in segments],
                         ["title", "section-0", "paragraph-0", "paragraph-1", "section-2",
                          "paragraph-2", "action-heading", "action"])
        self.assertEqual(segments[0]["text"], item["title"])
        self.assertEqual(segments[-2]["text"], "ひとつ、試してみる")
        self.assertEqual(segments[-1]["text"], item["reading"]["action"])
        paragraph_with_url = next(segment for segment in audio.speech_segments(article())
                                  if segment["key"] == "paragraph-1")
        self.assertEqual(paragraph_with_url["text"], audio.paragraphs(article())[1])
        self.assertNotIn("https://", paragraph_with_url["spoken"])

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
    def test_cue_boundaries_use_actual_chunk_frames_and_become_absolute_day_times(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            item = article()
            item["body"] = "長い段落の確認です。" * 35 + "\n\n短い段落。"
            calls = []
            measured = measured_fixture(item, root / "article.wav", calls)
            expected = audio.speech_segments(item)
            self.assertEqual([cue["key"] for cue in measured], [segment["key"] for segment in expected])
            self.assertGreater(len(calls), len(measured), "Long paragraph must use multiple measured chunks")
            lead = round(8000 * audio.LEADING_PAUSE_SECONDS)
            tail = round(8000 * audio.TRAILING_PAUSE_SECONDS)
            chunk_pause = round(8000 * audio.CHUNK_PAUSE_SECONDS)
            cursor = 0
            call_index = 0
            for index, (cue, segment) in enumerate(zip(measured, expected)):
                self.assertEqual(cue["startFrame"], cursor)
                chunks = audio.speech_chunks(segment["spoken"])
                self.assertEqual([call["text"] for call in calls[call_index:call_index + len(chunks)]], chunks)
                signal_frames = sum(call["frames"] for call in calls[call_index:call_index + len(chunks)])
                cursor += signal_frames + chunk_pause * len(chunks)
                if index == 0:
                    cursor += lead
                if index == len(measured) - 1:
                    cursor += tail - chunk_pause
                self.assertEqual(cue["endFrame"], cursor)
                self.assertEqual(cue["text"], segment["text"])
                call_index += len(chunks)
            with wave.open(str(root / "article.wav"), "rb") as wav:
                self.assertEqual(wav.getnframes(), cursor)
                raw = wav.readframes(cursor)
            # Rebounding during day assembly must not shift any cue even one frame.
            self.assertEqual(audio.bounded_pcm(root / "article.wav")[1], raw)
            articles = [dict(item, id=f"2026-11-03-{index}") for index in range(1, 4)]
            chapters, duration = audio.concatenate_articles(articles, [root / "article.wav"] * 3,
                                                            root / "day.wav", [measured] * 3)
            for index, chapter in enumerate(chapters):
                self.assertEqual(chapter["cues"][0]["start"], chapter["start"])
                self.assertEqual(chapter["cues"][-1]["end"], chapter["end"])
                for local, absolute in zip(measured, chapter["cues"]):
                    self.assertEqual(absolute["start"], (index * cursor + local["startFrame"]) / 8000)
                    self.assertEqual(absolute["end"], (index * cursor + local["endFrame"]) / 8000)
                    self.assertEqual(absolute["text"], local["text"])
                for previous, following in zip(chapter["cues"], chapter["cues"][1:]):
                    self.assertEqual(previous["end"], following["start"])
            self.assertEqual(duration, 3 * cursor / 8000)

    def test_mismatched_measured_cues_fail_before_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            item = article()
            measured = measured_fixture(item, root / "article.wav")
            corruptions = [lambda cues: cues[1].update(startFrame=cues[1]["startFrame"] + 1),
                           lambda cues: cues[-1].update(endFrame=cues[-1]["endFrame"] - 1),
                           lambda cues: cues[0].update(text="違う記事のタイトル"),
                           lambda cues: cues[2].update(key="paragraph-999")]
            for corrupt in corruptions:
                cues = copy.deepcopy(measured)
                corrupt(cues)
                with self.subTest(corrupt=corrupt), self.assertRaises(audio.AudioError):
                    audio.concatenate_articles([item], [root / "article.wav"], root / "day.wav", [cues])

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


class TraceAndRepairTest(unittest.TestCase):
    tools = {"open_jtalk": "fake-jtalk", "dictionary": "unused", "voice": "unused"}

    def test_trace_uses_100ns_ticks_and_frame_period_in_samples(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_wav(root / "voice.wav", frames=4800, rate=48000, padding=480)
            write_trace(root / "voice.txt", [("sil", 480), ("a", 4800), ("sil", 480)], rate=48000, period=240)
            self.assertEqual(audio.read_synthesis_trace(root / "voice.txt", root / "voice.wav"),
                             [("sil", .01), ("a", .1), ("sil", .01)])

    def test_failed_oversized_or_inconsistent_trace_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wav, trace = root / "voice.wav", root / "voice.txt"
            write_wav(wav, frames=400, padding=320)
            write_trace(trace, [("sil", 320), ("a", 400), ("sil", 320)])
            valid = trace.read_text()
            invalid = ["", "[Output label]\nfailed\n", valid.replace("[Global parameter]", "missing"),
                       valid.replace("8000(Hz)", "48000(Hz)"), valid.replace("5.00000(msec)", "240.00000(msec)"),
                       valid.replace("40(point)", "0(point)"), valid.replace("HMMs -> 3", "HMMs -> 4"),
                       valid.replace("400000 900000", "400001 900000"),
                       valid.replace("900000 1300000", "900000 1300001"),
                       valid.replace("-a+", "-sil+")]
            for value in invalid:
                trace.write_text(value)
                with self.subTest(trace=value[:80]), self.assertRaises(audio.AudioError):
                    audio.read_synthesis_trace(trace, wav)
            trace.write_text(valid)
            with patch.object(audio, "MAX_TRACE_BYTES", 16), self.assertRaises(audio.AudioError):
                audio.read_synthesis_trace(trace, wav)
            with patch.object(audio, "MAX_TRACE_LABELS", 2), self.assertRaises(audio.AudioError):
                audio.read_synthesis_trace(trace, wav)
            trace.unlink()
            with self.assertRaises(audio.AudioError):
                audio.read_synthesis_trace(trace, wav)

    def test_only_sustained_slow_speech_triggers_repair(self):
        self.assertEqual(audio.slow_phoneme_run([("a", .25)] * 8), 0)
        self.assertEqual(audio.slow_phoneme_run([("a", .6), ("i", .1)] * 8), 1)
        self.assertEqual(audio.slow_phoneme_run([("a", .4)] * 4 + [("pau", 1)] + [("a", .4)] * 4), 4)
        self.assertEqual(audio.slow_phoneme_run([("sil", 3), ("pau", 2)] * 8), 0)
        self.assertEqual(audio.slow_phoneme_run([("a", .3)] * 5), 5)
        self.assertLess(audio.slow_phoneme_run([("d", .435), ("e", .435), ("k", .435)]),
                        audio.SLOW_PHONEME_RUN)
        self.assertGreaterEqual(audio.slow_phoneme_run([("d", .435), ("e", .435), ("k", .435), ("i", .435)]),
                                audio.SLOW_PHONEME_RUN)

    def test_isolated_long_vowels_and_runs_of_three_retain_original_pcm(self):
        cases = [[("a", 4800), ("i", 400)],
                 [("a", 2400), ("i", 2400), ("u", 2400)],
                 [("d", 2400), ("e", 2400), ("k", 2400), ("pau", 320),
                  ("a", 2400), ("i", 2400), ("u", 2400)]]
        with tempfile.TemporaryDirectory() as temporary:
            for phones in cases:
                frames = sum(frames for _, frames in phones)
                def synth(arguments, *, input_text=None, **kwargs):
                    write_wav(Path(arguments[arguments.index("-ow") + 1]), frames=frames, padding=320)
                    write_trace(Path(arguments[arguments.index("-ot") + 1]), [("sil", 320), *phones, ("sil", 320)])
                    return ""
                with self.subTest(phones=phones), patch.object(audio, "command", side_effect=synth) as command:
                    leaves = audio.synthesize_chunk("自然な短い発声の確認です。", Path(temporary), self.tools)
                self.assertEqual(command.call_count, 1)
                self.assertEqual(len(leaves), 1)
                self.assertLess(audio.slow_phoneme_run(leaves[0]["phonemes"]), audio.SLOW_PHONEME_RUN)
                self.assertEqual(leaves[0]["pcm"], struct.pack("<hh", 5000, -5000) * (frames // 2))

    def test_repair_split_preserves_spaces_numbers_and_latin_words(self):
        for token in ("4,239", "1,000", "7.5％", "WACC"):
            source = "あ" * 10 + token + "い" * 10
            with self.subTest(token=token):
                left, right = audio.split_slow_chunk(source)
                self.assertEqual(left + right, source)
                self.assertTrue(token in left or token in right)
        source = "longword WACC longword"
        self.assertEqual("".join(audio.split_slow_chunk(source)), source)
        with self.assertRaises(audio.AudioError):
            audio.split_slow_chunk("WACC")

    def test_short_numeric_expression_split_requires_complete_operands(self):
        for source in ("7.5％×0.4＋1.5％", " 1,000.5％＋7.5％。 ", "1＋2＝3。"):
            with self.subTest(source=source):
                split = audio.split_short_numeric_expression(source)
                self.assertIsNotNone(split)
                left, right = split
                self.assertEqual(left + right, source)
                self.assertIn(left[-1], audio.MATH_OPERATORS)
                self.assertTrue(any(char.isdigit() for char in right))
                for token in audio.SPEECH_TOKEN.findall(source):
                    self.assertTrue(token in left or token in right)
        for source in ("WACC", "短い日本語です。", "WACC＋1.5％", "7.5％×", "×0.4＋1.5％",
                       "7.5％×0.4＋", "7.5％×0.4円", "7.5％×0..4", "1,00＋2", "1.5％％＋2",
                       "1＋2。本文", "12345"):
            with self.subTest(source=source):
                self.assertIsNone(audio.split_short_numeric_expression(source))

    def test_only_verified_slow_complete_short_formulas_can_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            formula = "7.5％×0.4＋1.5％"
            def synth(arguments, *, input_text=None, **kwargs):
                return synthetic_jtalk(arguments, input_text, slow=input_text.strip() == formula)
            with patch.object(audio, "command", side_effect=synth) as command:
                leaves = audio.synthesize_chunk(formula, root, self.tools)
            self.assertEqual(command.call_count, 3)
            self.assertEqual("".join(leaf["text"] for leaf in leaves), formula)
            self.assertEqual(len(leaves), 2)
            with patch.object(audio, "command", side_effect=synthetic_jtalk) as command:
                normal = audio.synthesize_chunk(formula, root, self.tools)
            self.assertEqual(command.call_count, 1)
            self.assertEqual(len(normal), 1)
            for source in ("WACC", "短い日本語です。", "7.5％×", "WACC＋1.5％"):
                def always_slow(arguments, *, input_text=None, **kwargs):
                    return synthetic_jtalk(arguments, input_text, slow=True)
                with self.subTest(source=source), patch.object(audio, "command", side_effect=always_slow) as command, \
                        self.assertRaises(audio.AudioError):
                    audio.synthesize_chunk(source, root, self.tools)
                self.assertEqual(command.call_count, 1)

    def test_short_formula_repairs_retain_depth_and_call_limits(self):
        with tempfile.TemporaryDirectory() as temporary:
            def always_slow(arguments, *, input_text=None, **kwargs):
                return synthetic_jtalk(arguments, input_text, slow=True)
            for name, limit in (("MAX_REPAIR_DEPTH", 0), ("MAX_SYNTHESIS_CALLS", 1)):
                with self.subTest(limit=name), patch.object(audio, name, limit), \
                        patch.object(audio, "command", side_effect=always_slow) as command, \
                        self.assertRaises(audio.AudioError):
                    audio.synthesize_chunk("7.5％×0.4＋1.5％", Path(temporary), self.tools)
                self.assertEqual(command.call_count, 1)

    def test_adaptive_splits_preserve_text_and_keep_each_normal_leaf(self):
        with tempfile.TemporaryDirectory() as temporary:
            calls = []
            def synth(arguments, *, input_text=None, **kwargs):
                text = input_text.strip()
                slow = len(text.encode()) > 65
                calls.append((text, slow))
                self.assertEqual(arguments[arguments.index("-r") + 1], "1.0")
                return synthetic_jtalk(arguments, input_text, slow)
            source = "本文の言葉を変えず、異常な発声時間だけを検知して分割します。正常な部分はそのまま保持します。"
            with patch.object(audio, "command", side_effect=synth):
                leaves = audio.synthesize_chunk(source, Path(temporary), self.tools)
            self.assertEqual("".join(leaf["text"] for leaf in leaves), source)
            self.assertEqual(len(calls), 2 * len(leaves) - 1)
            self.assertLessEqual(len(calls), audio.MAX_SYNTHESIS_CALLS)
            for leaf in leaves:
                self.assertEqual(calls.count((leaf["text"], False)), 1)
                self.assertEqual(audio.slow_phoneme_run(leaf["phonemes"]), 0)
                self.assertEqual(leaf["pcm"], struct.pack("<hh", 5000, -5000) * 200)

    def test_unrepairable_speech_stops_at_size_depth_and_retry_limits(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = "常に異常が続く発声を無限に再試行することはありません。"
            for name, limit in [("MIN_REPAIR_BYTES", 300), ("MAX_REPAIR_DEPTH", 0), ("MAX_SYNTHESIS_CALLS", 1)]:
                def synth(arguments, *, input_text=None, **kwargs):
                    return synthetic_jtalk(arguments, input_text, slow=True)
                with self.subTest(limit=name), patch.object(audio, name, limit), \
                        patch.object(audio, "command", side_effect=synth) as command, \
                        self.assertRaises(audio.AudioError):
                    audio.synthesize_chunk(source, Path(temporary), self.tools)
                self.assertEqual(command.call_count, 1)

    def test_all_slow_retries_are_bounded_across_both_branches(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = "分割後にも異常が続く長い本文を使って呼び出し回数の上限を確かめます。" * 2
            def synth(arguments, *, input_text=None, **kwargs):
                return synthetic_jtalk(arguments, input_text, slow=len(input_text.strip().encode()) > 40)
            with patch.object(audio, "MIN_REPAIR_BYTES", 0), \
                    patch.object(audio, "MAX_REPAIR_DEPTH", 10), \
                    patch.object(audio, "MAX_SYNTHESIS_CALLS", 5), \
                    patch.object(audio, "command", side_effect=synth) as command, \
                    self.assertRaises(audio.AudioError):
                audio.synthesize_chunk(source, Path(temporary), self.tools)
            self.assertEqual(command.call_count, 5)

    def test_malformed_or_oversized_slow_pcm_is_rejected_before_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for corruption in ("stereo", "eight-bit", "truncated", "oversized"):
                def synth(arguments, *, input_text=None, **kwargs):
                    synthetic_jtalk(arguments, input_text, slow=True)
                    path = Path(arguments[arguments.index("-ow") + 1])
                    if corruption == "truncated":
                        path.write_bytes(path.read_bytes()[:-2])
                    elif corruption in ("stereo", "eight-bit"):
                        frames = 12640
                        channels, width = (2, 2) if corruption == "stereo" else (1, 1)
                        with wave.open(str(path), "wb") as wav:
                            wav.setnchannels(channels)
                            wav.setsampwidth(width)
                            wav.setframerate(8000)
                            wav.writeframes(b"\1" * (frames * channels * width))
                    return ""
                limit = 1 if corruption == "oversized" else audio.MAX_ARTICLE_SECONDS
                with self.subTest(corruption=corruption), \
                        patch.object(audio, "MAX_ARTICLE_SECONDS", limit), \
                        patch.object(audio, "command", side_effect=synth) as command, \
                        self.assertRaises(audio.AudioError):
                    audio.synthesize_chunk("異常な音声は分割しても修復せず直ちに停止します。", root, self.tools)
                self.assertEqual(command.call_count, 1)

    def test_missing_new_trace_cannot_reuse_an_old_successful_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_wav(root / "chunk.wav", frames=400, padding=320)
            write_trace(root / "chunk.txt", [("sil", 320), ("a", 400), ("sil", 320)])
            with patch.object(audio, "command", return_value=""), self.assertRaises(audio.AudioError):
                audio.synthesize_chunk("正常な本文。", root, self.tools)

    def test_missing_new_wav_cannot_reuse_an_old_successful_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_wav(root / "chunk.wav", frames=400, padding=320)
            def trace_only(arguments, **kwargs):
                write_trace(root / "chunk.txt", [("sil", 320), ("a", 400), ("sil", 320)])
                return ""
            with patch.object(audio, "command", side_effect=trace_only), self.assertRaises(audio.AudioError):
                audio.synthesize_chunk("正常な本文。", root, self.tools)

    def test_article_cues_count_only_accepted_pcm_after_repairs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            calls = []
            def synth(arguments, *, input_text=None, **kwargs):
                slow = len(input_text.strip().encode()) > 65
                calls.append(slow)
                return synthetic_jtalk(arguments, input_text, slow)
            item = {"id": "2026-11-05-1", "title": "正常な見出し", "body": "長い文章の発声を測ります。" * 8}
            with patch.object(audio, "command", side_effect=synth):
                cues = audio.synthesize_article(item, root / "article.wav", self.tools)
            accepted = calls.count(False)
            total = (accepted * 400 + round(8000 * audio.LEADING_PAUSE_SECONDS) +
                     (accepted - 1) * round(8000 * audio.CHUNK_PAUSE_SECONDS) +
                     round(8000 * audio.TRAILING_PAUSE_SECONDS))
            self.assertGreater(calls.count(True), 0)
            self.assertEqual(cues[0]["endFrame"], round(8000 * audio.LEADING_PAUSE_SECONDS) + 400 +
                             round(8000 * audio.CHUNK_PAUSE_SECONDS))
            self.assertEqual(cues[1]["startFrame"], cues[0]["endFrame"])
            self.assertEqual(cues[1]["endFrame"], total)
            self.assertEqual(cues[1]["text"], item["body"])
            with wave.open(str(root / "article.wav")) as wav:
                self.assertEqual(wav.getnframes(), total)


class NativeSpeechRepairTest(unittest.TestCase):
    def setUp(self):
        try:
            self.tools = audio.toolchain()
        except audio.AudioError as exc:
            self.skipTest(str(exc))

    def baseline(self, text, root):
        wav, trace = root / "baseline.wav", root / "baseline.txt"
        audio.command([self.tools["open_jtalk"], "-x", self.tools["dictionary"], "-m", self.tools["voice"],
                       "-r", "1.0", "-ow", str(wav), "-ot", str(trace)], input_text=text + "\n")
        phones = audio.read_synthesis_trace(trace, wav)
        rate, pcm = audio.bounded_pcm(wav, leading_pause=0, trailing_pause=0)
        return phones, rate, pcm

    def test_minimal_model_regression_and_normal_pcm_preservation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            slow = "国営企業化で2024年1月に発足した事業者です。"
            normal = "2024年1月に発足した事業者です。"
            bad_phones, rate, bad_pcm = self.baseline(slow, root)
            good_phones, good_rate, good_pcm = self.baseline(normal, root)
            self.assertGreaterEqual(audio.slow_phoneme_run(bad_phones), 5)
            self.assertEqual(audio.slow_phoneme_run(good_phones), 0)
            self.assertAlmostEqual(len(bad_pcm) / 2 / rate + .2, 9.318, delta=.15)
            self.assertAlmostEqual(len(good_pcm) / 2 / good_rate + .2, 3.422, delta=.15)
            leaves = audio.synthesize_chunk(slow, root, self.tools)
            self.assertEqual("".join(leaf["text"] for leaf in leaves), slow)
            self.assertTrue(all(audio.slow_phoneme_run(leaf["phonemes"]) == 0 for leaf in leaves))
            repaired = sum(len(leaf["pcm"]) / 2 / leaf["rate"] + .2 for leaf in leaves)
            self.assertLess(repaired, 7)
            with patch.object(audio, "command", wraps=audio.command) as command:
                retained = audio.synthesize_chunk(normal, root, self.tools)
            self.assertEqual(command.call_count, 1)
            self.assertEqual(len(retained), 1)
            self.assertEqual(retained[0]["pcm"], good_pcm)

    def test_two_published_slow_paragraphs_are_repaired_without_changing_text(self):
        fixtures = [
            ("これは2026年4月1日のJR東日本の公式記事を基にした仕組みの解説です。同社は、電気をつくる段階だけでなく、送る・ためる・使う段階でも効率化を進めています。ここで示す図は利用方法の模式図で、", 30.1765),
            ("締結は2026年10月28日、発表は11月4日です。台湾で締結式を行い、今後は定期的な意見交換や相互視察を通じて協力を進めます。台鉄公司は、旧台湾鉄路管理局の国営企業化で2024年1月に発足した事業者です。", 28.2465),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for text, previous in fixtures:
                with self.subTest(text=text[:30]):
                    phones, rate, pcm = self.baseline(text, root)
                    self.assertGreaterEqual(audio.slow_phoneme_run(phones), 5)
                    self.assertAlmostEqual(len(pcm) / 2 / rate + .2, previous, delta=.15)
                    leaves = audio.synthesize_chunk(text, root, self.tools)
                    self.assertEqual("".join(leaf["text"] for leaf in leaves), text)
                    self.assertTrue(all(audio.slow_phoneme_run(leaf["phonemes"]) == 0 for leaf in leaves))
                    self.assertTrue(all(max(seconds for phone, seconds in leaf["phonemes"] if phone not in ("sil", "pau"))
                                        <= .25 for leaf in leaves))
                    self.assertLess(sum(len(leaf["pcm"]) / 2 / leaf["rate"] + .2 for leaf in leaves), previous * .85)

    def test_published_short_numeric_formula_is_repaired_without_splitting_numbers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for text in ("7.5％×0.4＋1.5％", "7.5％×0.4＋1.5％×0.6＝3.9％。"):
                with self.subTest(text=text):
                    phones, rate, pcm = self.baseline(text, root)
                    self.assertGreaterEqual(audio.slow_phoneme_run(phones), 5)
                    with patch.object(audio, "command", wraps=audio.command) as command:
                        leaves = audio.synthesize_chunk(text, root, self.tools)
                    self.assertLessEqual(command.call_count, audio.MAX_SYNTHESIS_CALLS)
                    self.assertEqual("".join(leaf["text"] for leaf in leaves), text)
                    for token in audio.SPEECH_TOKEN.findall(text):
                        self.assertTrue(any(token in leaf["text"] for leaf in leaves))
                    self.assertTrue(all(audio.slow_phoneme_run(leaf["phonemes"]) == 0 for leaf in leaves))
                    self.assertLessEqual(max(seconds for leaf in leaves for phone, seconds in leaf["phonemes"]
                                             if phone not in ("sil", "pau")), .25)
                    self.assertLess(sum(len(leaf["pcm"]) / 2 / leaf["rate"] + .2 for leaf in leaves),
                                    (len(pcm) / 2 / rate + .2) * .75)
            normal = "7.5％×0.4"
            _, _, pcm = self.baseline(normal, root)
            with patch.object(audio, "command", wraps=audio.command) as command:
                leaves = audio.synthesize_chunk(normal, root, self.tools)
            self.assertEqual(command.call_count, 1)
            self.assertEqual(leaves[0]["pcm"], pcm)

    def test_four_stretched_consonants_and_vowels_in_published_chunk_are_repaired(self):
        text = ("従来は故障情報でエリアを絞り、現地でケースを一つずつ開けていました。"
                "新しい浸水検知モジュールをケース内に設置すると浸水箇所を特定でき、"
                "開けるケースは1箇所に。過去の事象を例にした比較では、")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            phones, rate, pcm = self.baseline(text, root)
            self.assertEqual(audio.slow_phoneme_run(phones), 4)
            stretched = [(phone, seconds) for phone, seconds in phones
                         if phone not in ("sil", "pau") and seconds > .25]
            self.assertEqual([phone for phone, _ in stretched], ["d", "e", "k", "i"])
            self.assertTrue(all(abs(seconds - .435) < .005 for _, seconds in stretched))
            leaves = audio.synthesize_chunk(text, root, self.tools)
            self.assertEqual("".join(leaf["text"] for leaf in leaves), text)
            self.assertTrue(all(audio.slow_phoneme_run(leaf["phonemes"]) == 0 for leaf in leaves))
            self.assertLessEqual(max(seconds for leaf in leaves for phone, seconds in leaf["phonemes"]
                                     if phone not in ("sil", "pau")), .25)
            self.assertLess(sum(len(leaf["pcm"]) / 2 / leaf["rate"] + .2 for leaf in leaves),
                            len(pcm) / 2 / rate + .2 - 1)


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
                cues = audio.synthesize_article(item, path, tools)
                with wave.open(str(path), "rb") as wav:
                    durations.append(wav.getnframes() / wav.getframerate())
                    self.assertEqual(cues[-1]["endFrame"], wav.getnframes())
                    self.assertEqual(cues[0]["startFrame"], 0)
                    pcm = wav.readframes(wav.getnframes())
                self.assertEqual(audio.bounded_pcm(path)[1], pcm,
                                 "Day assembly must preserve measured native-voice boundaries")
                self.assertEqual([cue["key"] for cue in cues], ["title", "paragraph-0"])
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
        return measured_fixture(item, output)

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
                for chapter in day["articles"]:
                    self.assertEqual(chapter["cues"][0]["start"], chapter["start"])
                    self.assertEqual(chapter["cues"][-1]["end"], chapter["end"])
                    self.assertEqual([cue["key"] for cue in chapter["cues"]],
                                     [segment["key"] for segment in audio.speech_segments(article())])
                    self.assertEqual([cue["text"] for cue in chapter["cues"]],
                                     [segment["text"] for segment in audio.speech_segments(article())])
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

    def test_unrepairable_speech_preserves_previous_manifest_and_audio(self):
        tools = {name: shutil.which(name) for name in ["ffmpeg", "ffprobe"]}
        tools.update(TraceAndRepairTest.tools)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio_dir = self.make_project(root)
            before = {path.name: path.read_bytes() for path in audio_dir.iterdir()}
            def synth(arguments, *, input_text=None, **kwargs):
                self.assertEqual(arguments[0], "fake-jtalk", "Failed repair must stop before encoding/publication")
                return synthetic_jtalk(arguments, input_text, slow=True)
            with patch.object(audio, "toolchain", return_value=tools), \
                    patch.object(audio, "command", side_effect=synth), self.assertRaises(audio.AudioError):
                audio.build_audio(root / "dist", root)
            self.assertEqual({path.name: path.read_bytes() for path in audio_dir.iterdir()}, before)


class ArchiveResponse(io.BytesIO):
    def __init__(self, payload, url, *, headers=None, status=200):
        super().__init__(payload)
        self.url = url
        self.status = status
        self.headers = {"Content-Length": str(len(payload))} if headers is None else headers

    def geturl(self):
        return self.url

    def getcode(self):
        return self.status


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Local ffmpeg/ffprobe required")
class PublishedArchiveTest(unittest.TestCase):
    manifest_url = "https://example.test/ai-daily/audio/index.json"
    base_url = "https://example.test/ai-daily/"

    @classmethod
    def setUpClass(cls):
        cls.tools = {name: shutil.which(name) for name in ("ffmpeg", "ffprobe")}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            audio_dir = Mp3PublicationTest.make_project(cls, root)
            (root / "content" / "2026-11-03.json").unlink()
            with patch.object(audio, "toolchain", return_value=cls.tools), \
                    patch.object(audio, "synthesize_article", side_effect=Mp3PublicationTest.fake_synthesis), \
                    contextlib.redirect_stdout(io.StringIO()):
                audio.build_audio(root / "dist", root)
            cls.archive = json.loads((audio_dir / "index.json").read_text())
            cls.mp3s = {path.name: path.read_bytes() for path in audio_dir.glob("*.mp3")}

    def make_project(self, root):
        directory = Mp3PublicationTest.make_project(self, root)
        (root / "site.json").write_text(json.dumps({"baseUrl": self.base_url}))
        return directory

    def network(self, manifest=None, payloads=None):
        manifest = self.archive if manifest is None else manifest
        files = self.mp3s if payloads is None else payloads
        def fetch(url):
            if url == self.manifest_url:
                return ArchiveResponse(json.dumps(manifest, ensure_ascii=False).encode(), url)
            filename = url.removeprefix(self.manifest_url.removesuffix("index.json"))
            if filename not in files:
                raise AssertionError(f"Unexpected archive request: {url}")
            return ArchiveResponse(files[filename], url)
        return fetch

    def test_old_bytes_and_metadata_are_unchanged_and_only_new_day_is_synthesized(self):
        manifest = copy.deepcopy(self.archive)
        manifest["days"]["2026-11-01"]["legacyField"] = {"preserve": ["all", "metadata", 1.25]}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = self.make_project(root)
            with patch.object(audio, "toolchain", return_value=self.tools), \
                    patch.object(audio, "open_published_url", side_effect=self.network(manifest)) as fetch, \
                    patch.object(audio, "synthesize_article", side_effect=Mp3PublicationTest.fake_synthesis) as synth, \
                    contextlib.redirect_stdout(io.StringIO()):
                result = audio.build_audio(root / "dist", root, published_archive=self.manifest_url)
            actual = json.loads((directory / "index.json").read_text())
            self.assertEqual([call.args[0]["id"] for call in synth.call_args_list],
                             [f"2026-11-03-{index}" for index in range(1, 4)])
            self.assertEqual(fetch.call_count, 3)
            for date, entry in manifest["days"].items():
                self.assertEqual(actual["days"][date], entry)
                self.assertEqual((directory / entry["url"]).read_bytes(), self.mp3s[entry["url"]])
            self.assertEqual(result["days"], 3)
            self.assertEqual(len(list(directory.glob("*.mp3"))), 3)
            self.assertLessEqual(result["bytes"], audio.MAX_OUTPUT_BYTES)

    def test_an_all_published_build_never_synthesizes_or_examines_phonemes(self):
        manifest = copy.deepcopy(self.archive)
        # Older chapter-only editions remain usable without inventing new cues.
        for chapter in manifest["days"]["2026-11-01"]["articles"]:
            chapter.pop("cues")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = self.make_project(root)
            (root / "content" / "2026-11-03.json").unlink()
            with patch.object(audio, "toolchain", return_value=self.tools), \
                    patch.object(audio, "open_published_url", side_effect=self.network(manifest)), \
                    patch.object(audio, "synthesize_article", side_effect=AssertionError("Old audio must not be synthesized")), \
                    patch.object(audio, "read_synthesis_trace", side_effect=AssertionError("Old phonemes must not be inspected")), \
                    patch.object(audio, "encode_mp3", side_effect=AssertionError("Old MP3s must not be re-encoded")), \
                    contextlib.redirect_stdout(io.StringIO()):
                audio.build_audio(root / "dist", root, published_archive=self.manifest_url)
            self.assertEqual(json.loads((directory / "index.json").read_text())["days"], manifest["days"])
            for entry in manifest["days"].values():
                self.assertEqual((directory / entry["url"]).read_bytes(), self.mp3s[entry["url"]])

    def test_untrusted_manifest_paths_and_origins_fail_before_network_or_synthesis(self):
        invalid = ["", "http://example.test/ai-daily/audio/index.json",
                   "https://other.test/ai-daily/audio/index.json",
                   "https://example.test/other/audio/index.json",
                   self.manifest_url + "?token=bad", self.manifest_url + "#bad",
                   "https://user@example.test/ai-daily/audio/index.json"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = self.make_project(root)
            before = {path.name: path.read_bytes() for path in directory.iterdir()}
            for url in invalid:
                with self.subTest(url=url), patch.object(audio, "toolchain", return_value=self.tools), \
                        patch.object(audio, "open_published_url") as fetch, \
                        patch.object(audio, "synthesize_article") as synth, self.assertRaises(audio.AudioError):
                    audio.build_audio(root / "dist", root, published_archive=url)
                fetch.assert_not_called()
                synth.assert_not_called()
                self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()}, before)

    def test_archive_download_limits_preserve_existing_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = self.make_project(root)
            before = {path.name: path.read_bytes() for path in directory.iterdir()}
            for name in ("MAX_ARCHIVE_MANIFEST_BYTES", "MAX_OUTPUT_BYTES"):
                with self.subTest(limit=name), patch.object(audio, name, 1), \
                        patch.object(audio, "toolchain", return_value=self.tools), \
                        patch.object(audio, "open_published_url", side_effect=self.network()), \
                        patch.object(audio, "synthesize_article") as synth, self.assertRaises(audio.AudioError):
                    audio.build_audio(root / "dist", root, published_archive=self.manifest_url)
                synth.assert_not_called()
                self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()}, before)

    def test_latest_fourteen_reuse_keeps_only_thirteen_old_files_and_one_new_day(self):
        archive = {"version": 1, "voice": dict(audio.VOICE), "days": {}}
        files = {}
        template = self.archive["days"]["2026-11-01"]
        days = [(audio.dt.date(2026, 10, 20) + audio.dt.timedelta(days=index)).isoformat() for index in range(15)]
        for date in days[:-1]:
            entry = copy.deepcopy(template)
            entry["url"] = f"{date}-{entry['sha256'][:12]}.mp3"
            for chapter, item in zip(entry["articles"], edition(date)["articles"]):
                chapter.update(id=item["id"], articleHash=audio.article_hash(item))
            archive["days"][date] = entry
            files[entry["url"]] = self.mp3s[template["url"]]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = self.make_project(root)
            for path in (root / "content").iterdir():
                path.unlink()
            for date in days:
                (root / "content" / f"{date}.json").write_text(json.dumps(edition(date)))
            with patch.object(audio, "toolchain", return_value=self.tools), \
                    patch.object(audio, "open_published_url", side_effect=self.network(archive, files)) as fetch, \
                    patch.object(audio, "synthesize_article", side_effect=Mp3PublicationTest.fake_synthesis) as synth, \
                    contextlib.redirect_stdout(io.StringIO()):
                result = audio.build_audio(root / "dist", root, published_archive=self.manifest_url)
            manifest = json.loads((directory / "index.json").read_text())
            self.assertEqual(list(manifest["days"]), days[1:])
            self.assertEqual(result["days"], 14)
            self.assertEqual(len(list(directory.glob("*.mp3"))), 14)
            self.assertEqual(fetch.call_count, 14)  # manifest + 13 retained published files
            self.assertTrue(all(call.args[0]["id"].startswith(days[-1]) for call in synth.call_args_list))
            self.assertEqual(synth.call_count, 3)
            for date in days[1:-1]:
                self.assertEqual(manifest["days"][date], archive["days"][date])

    def test_invalid_archive_metadata_or_source_never_regenerates_or_replaces_existing_audio(self):
        def first(manifest):
            return manifest["days"]["2026-11-01"]
        corruptions = [lambda m: m["voice"].update(name="Unknown voice"),
                       lambda m: m.update(version=True),
                       lambda m: first(m).update(url="../2026-11-01-000000000000.mp3"),
                       lambda m: first(m).update(url="https://other.test/audio.mp3"),
                       lambda m: first(m).update(url=first(m)["url"] + "?token=bad"),
                       lambda m: first(m).update(sha256="0" * 64),
                       lambda m: first(m).update(duration=float("nan")),
                       lambda m: first(m).update(duration=10 ** 999),
                       lambda m: first(m)["articles"][0].update(id="2026-11-01-2"),
                       lambda m: first(m)["articles"][0].update(articleHash="0" * 64),
                       lambda m: first(m)["articles"][0].update(title="Changed public title"),
                       lambda m: first(m)["articles"][1].update(start=999),
                       lambda m: first(m)["articles"][0]["cues"][0].update(text="Changed cue text"),
                       lambda m: first(m)["articles"][0]["cues"][0].update(end=999),
                       lambda m: first(m)["articles"][0].update(cues=None),
                       lambda m: m["days"].pop("2026-11-01")]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = self.make_project(root)
            before = {path.name: path.read_bytes() for path in directory.iterdir()}
            for corrupt in corruptions:
                manifest = copy.deepcopy(self.archive)
                corrupt(manifest)
                with self.subTest(corrupt=corrupt), patch.object(audio, "toolchain", return_value=self.tools), \
                        patch.object(audio, "open_published_url", side_effect=self.network(manifest)), \
                        patch.object(audio, "synthesize_article") as synth, self.assertRaises(audio.AudioError):
                    audio.build_audio(root / "dist", root, published_archive=self.manifest_url)
                synth.assert_not_called()
                self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()}, before)

    def test_bad_mp3_bytes_duration_and_attribution_preserve_previous_publication(self):
        first_date = "2026-11-01"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = self.make_project(root)
            before = {path.name: path.read_bytes() for path in directory.iterdir()}
            for corruption in ("bytes", "duration", "damaged", "attribution"):
                manifest = copy.deepcopy(self.archive)
                payloads = dict(self.mp3s)
                entry = manifest["days"][first_date]
                if corruption == "bytes":
                    payloads[entry["url"]] = b"different bytes"
                elif corruption == "duration":
                    entry["duration"] += 1
                    entry["articles"][-1]["end"] += 1
                    entry["articles"][-1]["cues"][-1]["end"] += 1
                else:
                    original = self.mp3s[entry["url"]]
                    data = b"broken MP3" if corruption == "damaged" else original
                    if corruption == "attribution":
                        for encoding in ("utf-8", "utf-16-le"):
                            needle = audio.VOICE["sourceUrl"].encode(encoding)
                            data = data.replace(needle, b"x" * len(needle))
                        self.assertNotEqual(data, original)
                    digest = hashlib.sha256(data).hexdigest()
                    entry.update(url=f"{first_date}-{digest[:12]}.mp3", sha256=digest)
                    payloads[entry["url"]] = data
                with self.subTest(corruption=corruption), patch.object(audio, "toolchain", return_value=self.tools), \
                        patch.object(audio, "open_published_url", side_effect=self.network(manifest, payloads)), \
                        patch.object(audio, "synthesize_article") as synth, \
                        self.assertRaises(audio.AudioError):
                    audio.build_audio(root / "dist", root, published_archive=self.manifest_url)
                synth.assert_not_called()
                self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()}, before)

    def test_fetch_denial_and_exhausted_transient_retries_never_fall_back_to_regeneration(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = self.make_project(root)
            before = {path.name: path.read_bytes() for path in directory.iterdir()}
            for code, expected in ((401, 1), (403, 1), (404, 1), (503, audio.ARCHIVE_DOWNLOAD_ATTEMPTS)):
                error = urllib.error.HTTPError(self.manifest_url, code, "test failure", {}, None)
                with self.subTest(code=code), patch.object(audio, "toolchain", return_value=self.tools), \
                        patch.object(audio, "open_published_url", side_effect=error) as fetch, \
                        patch.object(audio.time, "sleep"), patch.object(audio, "synthesize_article") as synth, \
                        self.assertRaises(audio.AudioError):
                    audio.build_audio(root / "dist", root, published_archive=self.manifest_url)
                self.assertEqual(fetch.call_count, expected)
                synth.assert_not_called()
                self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()}, before)

    def test_streaming_caps_truncation_redirects_and_transient_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "download"
            cases = [(ArchiveResponse(b"abcd", self.manifest_url, headers={}), 3),
                     (ArchiveResponse(b"a", self.manifest_url, headers={"Content-Length": "99"}), 3),
                     (ArchiveResponse(b"a", self.manifest_url, headers={"Content-Length": "2"}), 3),
                     (ArchiveResponse(b"", self.manifest_url, headers={}), 3),
                     (ArchiveResponse(b"a", "https://other.test/redirect"), 3),
                     (ArchiveResponse(b"a", self.manifest_url, status=206), 3)]
            for response, limit in cases:
                with self.subTest(response=response), patch.object(audio, "open_published_url", return_value=response), \
                        self.assertRaises(audio.AudioError):
                    audio.download_published(self.manifest_url, path, limit)
                self.assertFalse(path.exists())
            with patch.object(audio, "open_published_url", side_effect=[urllib.error.URLError("temporary"),
                              ArchiveResponse(b"ok", self.manifest_url)]) as fetch, patch.object(audio.time, "sleep"):
                self.assertEqual(audio.download_published(self.manifest_url, path, 3), 2)
            self.assertEqual(fetch.call_count, 2)
            self.assertEqual(path.read_bytes(), b"ok")
            with self.assertRaises(audio.AudioError):
                audio.RejectArchiveRedirects().redirect_request(None, None, 302, "redirect", {}, "https://other.test/")

    def test_archive_requests_revalidate_the_exact_url_without_redirects(self):
        with patch.object(audio.urllib.request, "build_opener") as build:
            audio.open_published_url(self.manifest_url)
        self.assertIs(build.call_args.args[0], audio.RejectArchiveRedirects)
        request = build.return_value.open.call_args.args[0]
        self.assertEqual(request.full_url, self.manifest_url)
        self.assertEqual(request.get_header("Cache-control"), "no-cache")
        self.assertEqual(request.get_header("Accept-encoding"), "identity")
        self.assertEqual(build.return_value.open.call_args.kwargs["timeout"], 30)


if __name__ == "__main__":
    unittest.main()
