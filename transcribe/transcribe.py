#!/usr/bin/env python3
"""
Turn one video/audio file into subtitle files.

The transcription pipeline is the user's Colab code, adapted to run headless on
a CPU GitHub Actions runner:

  ffmpeg (highpass + loudnorm) -> Silero VAD -> speech pieces (<=25s)
  -> Whisper (Oriserve Hinglish or openai/whisper) -> phrase-level lines whose
     cuts are snapped to the quietest nearby moment

One extra: the same generation call also asks for word timestamps, so the
word-by-word view and words.srt carry real timings instead of estimates. If the
model can't produce them, timing falls back to the length+snap estimator.

Outputs (in --outdir):
  transcript.srt   one cue per spoken phrase
  words.srt        one cue per word
  transcript.txt   plain text
  words.json       [{w, s, e}, ...]

Run locally:
  python transcribe/transcribe.py --input clip.mp4 --language hinglish --outdir out

Useful env vars:
  HINGLISH_MODEL / ENGLISH_MODEL   override the model id
  BEAMS=1      num_beams (GPU Colab used 5; CPU is ~5x slower per beam)
  BATCH=8      speech pieces per forward pass
  WORDS_PER_LINE=5   fallback when --words-per-line isn't passed
"""

import argparse
import gc
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------- settings
SR = 16000

DEFAULT_MODELS = {
    "hinglish": "Oriserve/Whisper-Hindi2Hinglish-Apex",
    "english": "openai/whisper-small",
}
MODEL_ENV = {"hinglish": "HINGLISH_MODEL", "english": "ENGLISH_MODEL"}

BEAMS = int(os.environ.get("BEAMS", "1"))
BATCH = int(os.environ.get("BATCH", "8"))

# How the audio is cut for transcription (longer = more context = better accuracy)
CHUNK_MIN = 8.0
CHUNK_MAX = 18.0
PAUSE = 0.35

# How the text is split into timestamped lines
SNAP = 0.5            # how far a cut may move to land on a pause
WORDS_PER_LINE = 5    # default; the site sends whatever the user picked
MAX_WORDS_PER_LINE = 10

PAD = 0.05  # tiny padding around each piece so word edges aren't clipped


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- audio
def to16k(src, dst):
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", src, "-vn", "-ac", "1", "-ar", str(SR),
        "-af", "highpass=f=80,loudnorm", dst,
    ]
    subprocess.run(cmd, check=True)


def load_wave(path):
    import soundfile as sf

    wave, sr = sf.read(path, dtype="float32")
    if wave.ndim > 1:
        wave = wave.mean(axis=1)
    if sr != SR:
        raise SystemExit(f"expected {SR} Hz audio, got {sr}")
    return wave


# ---------------------------------------------------------------- VAD
def speech_groups(wave):
    """Return [(start, end), ...] speech stretches, cut at pauses or max length."""
    import numpy as np

    # Energy envelope, used to snap cuts to the quietest point.
    WIN, HOP = int(0.05 * SR), int(0.01 * SR)
    cs = np.concatenate(([0.0], np.cumsum(wave.astype(np.float64) ** 2)))
    env = ((cs[WIN:] - cs[:-WIN]) / WIN)[::HOP]
    del cs

    def quietest(a, b):
        k0 = max(0, int((a * SR - WIN / 2) / HOP))
        k1 = min(len(env), max(k0 + 2, int((b * SR - WIN / 2) / HOP) + 1))
        k = k0 + int(np.argmin(env[k0:k1]))
        return min(max((k * HOP + WIN / 2) / SR, a), b)

    def split_long(s, e):
        out = []
        while e - s > CHUNK_MAX:
            a = s + CHUNK_MAX * 0.6
            b = max(a + 0.1, min(s + CHUNK_MAX, e - 1.0))
            cut = quietest(a, b)
            out.append([s, cut])
            s = cut
        out.append([s, e])
        return out

    try:
        import torch
        from silero_vad import get_speech_timestamps, load_silero_vad

        vad = load_silero_vad()
        spans = get_speech_timestamps(
            torch.from_numpy(wave),
            vad,
            sampling_rate=SR,
            return_seconds=True,
            min_speech_duration_ms=250,
            min_silence_duration_ms=200,
            speech_pad_ms=100,
        )
    except Exception as err:
        # VAD is a nicety; without it we still cut on energy minima.
        log(f"VAD unavailable ({err}); falling back to fixed windows")
        duration = len(wave) / SR
        spans = []
        step = CHUNK_MAX * 1.2
        t = 0.0
        while t < duration:
            spans.append({"start": t, "end": min(duration, t + step)})
            t += step

    merged, cur = [], None
    for sp in spans:
        s, e = sp["start"], sp["end"]
        if cur is None:
            cur = [s, e]
            continue
        gap = s - cur[1]
        if (e - cur[0] > CHUNK_MAX) or (gap >= PAUSE and cur[1] - cur[0] >= CHUNK_MIN):
            merged.append(cur)
            cur = [s, e]
        else:
            cur[1] = e
    if cur:
        merged.append(cur)

    return [g for m in merged for g in split_long(m[0], m[1])], quietest


# ---------------------------------------------------------------- text shaping
BREAK_CHARS = ",.!?;:\u2026\u0964"


def ends_clause(text):
    text = text.strip()
    return bool(text) and text[-1] in BREAK_CHARS


def group_items(items, per_line, text_of):
    """
    Split into lines of at most `per_line` items.

    A line should not drag a word past the comma or full stop that ends its
    thought: if one of the items before the last carries punctuation, the line
    ends there and the remaining items start the next line.
    """
    groups, i = [], 0
    while i < len(items):
        chunk = items[i: i + per_line]
        if len(chunk) == per_line:
            cut = 0
            for j in range(len(chunk) - 2, -1, -1):
                if ends_clause(text_of(chunk[j])):
                    cut = j + 1
                    break
            if cut:
                chunk = chunk[:cut]
        groups.append(chunk)
        i += len(chunk)
    return groups


def snap_bounds(widths, s, e, quietest):
    """Estimate cut points from relative length, then snap each to the nearest pause."""
    if len(widths) <= 1:
        return [s, e]
    total, acc, bounds = sum(widths), 0, [s]
    for width in widths[:-1]:
        acc += width
        est = s + (e - s) * acc / total
        lo = max(bounds[-1] + 0.2, est - SNAP)
        hi = min(e - 0.2, est + SNAP)
        if hi > lo + 0.05:
            b = quietest(lo, hi)
        else:
            b = min(max(est, bounds[-1] + 0.05), e - 0.05)
        bounds.append(b)
    bounds.append(e)
    return bounds


def words_from_output(out, clip_start):
    """Word chunks are relative to the piece we fed in."""
    words = []
    for chunk in out.get("chunks") or []:
        text = (chunk.get("text") or "").strip()
        if not text:
            continue
        ts = tuple(chunk.get("timestamp") or (None, None))
        start = ts[0] if len(ts) > 0 else None
        end = ts[1] if len(ts) > 1 else None
        if start is None:
            continue
        start = clip_start + float(start)
        end = clip_start + float(end) if end is not None else start + 0.4
        words.append({"text": text, "start": start, "end": max(end, start + 0.05)})
    return words


def lines_for_piece(text, words, per_line, s, e, quietest):
    """Cut one piece into lines of `per_line` words, using real word times if we have them."""
    if words:
        return [
            (group[0]["start"], group[-1]["end"], " ".join(w["text"] for w in group))
            for group in group_items(words, per_line, lambda w: w["text"])
        ]

    groups = group_items(text.split(), per_line, str)
    widths = [max(1, len(" ".join(g))) for g in groups]
    bounds = snap_bounds(widths, s, e, quietest)
    return [(bounds[i], bounds[i + 1], " ".join(g)) for i, g in enumerate(groups)]


def estimate_words(lines):
    """Last resort when a model returns no word timings at all."""
    words = []
    for line in lines:
        parts = line["text"].split()
        if not parts:
            continue
        span = max(0.05, line["end"] - line["start"])
        step = span / len(parts)
        for i, part in enumerate(parts):
            words.append(
                {
                    "text": part,
                    "start": line["start"] + i * step,
                    "end": line["start"] + (i + 1) * step,
                }
            )
    return words


# ---------------------------------------------------------------- whisper

# Fine-tuned Whisper checkpoints often ship without `alignment_heads`, which
# Whisper needs for word-level timestamps. The heads describe the base model's
# cross-attention, so borrow them from the checkpoint the model was fine-tuned
# from. Without this, asking for word timestamps raises and we lose them.
ALIGNMENT_BASE = {
    "Oriserve/Whisper-Hindi2Hinglish-Apex": "openai/whisper-large-v3-turbo",
    "Oriserve/Whisper-Hindi2Hinglish-Prime": "openai/whisper-large-v3",
}


def ensure_alignment_heads(asr, model_id):
    """Return True when the pipeline can produce word-level timestamps."""
    config = getattr(asr, "generation_config", None)
    if config is None:
        return False
    if getattr(config, "alignment_heads", None):
        return True

    base_id = os.environ.get("ALIGNMENT_HEADS_MODEL") or ALIGNMENT_BASE.get(model_id)
    if not base_id:
        return False
    try:
        from transformers import GenerationConfig

        heads = GenerationConfig.from_pretrained(base_id).alignment_heads
        if not heads:
            return False
        config.alignment_heads = heads
        if getattr(asr, "model", None) is not None:
            asr.model.generation_config.alignment_heads = heads
        log(f"word timings: borrowed alignment_heads from {base_id}")
        return True
    except Exception as err:
        log(f"word timings unavailable: {err}")
        return False


def run_model(clips, model_id):
    import torch
    from transformers import pipeline

    use_cuda = torch.cuda.is_available()
    device = 0 if use_cuda else -1
    dtype = torch.float16 if use_cuda else torch.float32
    log(f"loading {model_id} on {'GPU' if use_cuda else 'CPU'} (beams={BEAMS}, batch={BATCH})")

    asr = pipeline(
        "automatic-speech-recognition",
        model=model_id,
        torch_dtype=dtype,
        device=device,
    )
    word_timings = ensure_alignment_heads(asr, model_id)
    base = {"task": "transcribe", "num_beams": BEAMS}

    # Prefer word timestamps; fall back gracefully if this model/version can't.
    attempts = []
    if word_timings:
        attempts.append({"return_timestamps": "word", "generate_kwargs": {**base, "language": "en"}})
        attempts.append({"return_timestamps": "word", "generate_kwargs": dict(base)})
    attempts.append({"generate_kwargs": {**base, "language": "en"}})
    attempts.append({"generate_kwargs": dict(base)})

    def decode(batch, idx):
        """Try each attempt in turn, dropping the ones that fail for good.

        The pipeline consumes the dicts it is given (`raw` is popped), so every
        attempt needs a fresh copy — reusing them turned a single real error into
        a cascade of "dict needs a raw key" failures.
        """
        last = None
        while attempts:
            attempt = attempts[0]
            try:
                fresh = [{"raw": clip, "sampling_rate": SR} for clip in batch]
                return asr(fresh, batch_size=len(fresh), **attempt)
            except Exception as err:
                last = err
                attempts.pop(0)
                first = str(err).strip().splitlines()[0] if str(err).strip() else type(err).__name__
                log(f"  piece {idx}: {type(err).__name__}: {first}")
                if attempts:
                    log("  retrying without that option")
        raise last

    outs = []
    for b in range(0, len(clips), BATCH):
        outs.extend(decode(clips[b: b + BATCH], b))
        log(f"  transcribed {min(b + BATCH, len(clips))}/{len(clips)} pieces")

    del asr
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return outs


# ---------------------------------------------------------------- srt
def srt_time(seconds):
    seconds = max(0.0, float(seconds))
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_srt(cues):
    blocks = []
    for cue in cues:
        text = cue["text"].strip()
        if not text:
            continue
        start = cue["start"]
        end = cue["end"] if cue["end"] > cue["start"] else cue["start"] + 0.4
        blocks.append(f"{len(blocks) + 1}\n{srt_time(start)} --> {srt_time(end)}\n{text}\n")
    return "\n".join(blocks)


# ---------------------------------------------------------------- callback
def post_callback(url, token, payload):
    """Post a status ping. Returns False only when the request was rejected."""
    if not url:
        return None
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-callback-token": token or "",
            # Cloudflare's bot protection answers urllib's default
            # `Python-urllib/3.x` user agent with "403 error code: 1010", which
            # left every job stuck on "queued" even when transcription worked.
            "user-agent": "transcript-studio/1.0 (+https://github.com/RohanSM/Cool-Tools)",
            "accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            log(f"callback {payload.get('status')} -> {resp.status}")
            return True
    except urllib.error.HTTPError as err:
        log(f"callback failed: {err.code} {err.read()[:200]!r}")
    except Exception as err:  # a status ping must never crash the pipeline
        log(f"callback failed: {err}")
    return False


# ---------------------------------------------------------------- main
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--outdir", default="out")
    parser.add_argument("--language", choices=["hinglish", "english"], default="hinglish")
    parser.add_argument(
        "--words-per-line",
        type=int,
        default=int(os.environ.get("WORDS_PER_LINE", WORDS_PER_LINE)),
        help="words in each subtitle line (default 5)",
    )
    parser.add_argument("--model", default=None, help="override the Hugging Face model id")
    parser.add_argument("--callback-url", default="")
    parser.add_argument("--callback-token", default="")
    args = parser.parse_args()

    per_line = min(max(int(args.words_per_line), 1), MAX_WORDS_PER_LINE)
    log(f"lines hold up to {per_line} words")

    os.makedirs(args.outdir, exist_ok=True)
    model_id = args.model or os.environ.get(MODEL_ENV[args.language]) or DEFAULT_MODELS[args.language]

    post_callback(args.callback_url, args.callback_token, {"status": "processing"})

    try:
        with tempfile.TemporaryDirectory() as tmp:
            wav_path = os.path.join(tmp, "audio.wav")
            log(f"extracting audio from {args.input}")
            to16k(args.input, wav_path)
            wave = load_wave(wav_path)
            duration = len(wave) / SR
            log(f"audio length {duration:.1f}s")

            groups, quietest = speech_groups(wave)

        if not groups:
            raise RuntimeError("We couldn't hear any speech in that file.")

        log(f"speech found: {len(groups)} pieces to transcribe")
        slices = [(max(0.0, s - PAD), min(duration, e + PAD)) for s, e in groups]
        clips = [wave[int(a * SR): int(b * SR)] for a, b in slices]

        outs = run_model(clips, model_id)

        lines, words = [], []
        last_text, repeat = None, 0
        for idx, ((s, e), out) in enumerate(zip(groups, outs)):
            text = (out.get("text") or "").strip()
            if not text:
                continue
            repeat = repeat + 1 if text == last_text else 0
            last_text = text
            if repeat >= 2:  # drop only the 3rd+ identical repeat (hallucination loops)
                log(f"  piece {idx}: skipping repeated output")
                continue

            clip_words = words_from_output(out, slices[idx][0])
            for w in clip_words:
                w["start"] = min(max(w["start"], 0.0), duration)
                w["end"] = min(max(w["end"], w["start"] + 0.05), duration)

            for a, b, phrase in lines_for_piece(text, clip_words, per_line, s, e, quietest):
                lines.append({"start": a, "end": b, "text": phrase})
            words.extend(clip_words)

        lines.sort(key=lambda x: x["start"])
        words.sort(key=lambda x: x["start"])
        if not words:
            words = estimate_words(lines)

        srt = build_srt(lines)
        words_srt = build_srt(words)
        text = "\n".join(line["text"] for line in lines).strip()

        with open(os.path.join(args.outdir, "transcript.srt"), "w", encoding="utf-8") as fh:
            fh.write(srt)
        with open(os.path.join(args.outdir, "words.srt"), "w", encoding="utf-8") as fh:
            fh.write(words_srt)
        with open(os.path.join(args.outdir, "transcript.txt"), "w", encoding="utf-8") as fh:
            fh.write(text + "\n")

        payload_words = [
            {"w": w["text"], "s": round(w["start"], 3), "e": round(w["end"], 3)} for w in words
        ]
        with open(os.path.join(args.outdir, "words.json"), "w", encoding="utf-8") as fh:
            json.dump(payload_words, fh, ensure_ascii=False)

        log(f"done: {len(lines)} lines, {len(words)} words")

        if not text:
            raise RuntimeError("We couldn't hear any speech in that file.")

        delivered = post_callback(
            args.callback_url,
            args.callback_token,
            {
                "status": "done",
                "result": {
                    "srt": srt,
                    "wordsSrt": words_srt,
                    "text": text,
                    "words": payload_words,
                    "duration": round(duration, 2),
                    "model": model_id,
                },
            },
        )
        # If the result never reaches the site the user just polls forever, so
        # fail the run instead: the workflow then reports the failure with curl.
        if delivered is False:
            raise RuntimeError(
                "The transcript was ready but couldn't be sent back to the site. Please try again."
            )
    except subprocess.CalledProcessError as err:
        log(f"ffmpeg failed: {err}")
        post_callback(
            args.callback_url,
            args.callback_token,
            {
                "status": "failed",
                "error": "We couldn't read that audio. Try a different file format (MP4, MOV, MP3 or WAV).",
            },
        )
        sys.exit(1)
    except Exception as err:
        log(f"transcription failed: {err}")
        post_callback(
            args.callback_url,
            args.callback_token,
            {"status": "failed", "error": str(err) if isinstance(err, RuntimeError) else
             "The transcription engine hit a problem. Try again, or use a shorter file."},
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
