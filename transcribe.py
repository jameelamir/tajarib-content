#!/usr/bin/env python3
"""
Step 1: Transcribe an episode video/audio file using faster-whisper.
Outputs word-level timestamped transcript to episodes/{slug}/transcript.json

Usage:
  python3 transcribe.py <video_file> [--slug my-episode] [--model large-v3] [--force]
"""

import argparse
import json
import os
import sys
import re
from pathlib import Path
from faster_whisper import WhisperModel

def slugify(name):
    """Create a filesystem-safe slug from a filename."""
    name = Path(name).stem  # remove extension
    name = re.sub(r'[^\w\s-]', '', name)
    name = re.sub(r'[\s_]+', '-', name.strip())
    return name

def transcribe(video_path, slug=None, model_name="large-v3", force=False):
    video_path = Path(video_path).resolve()
    if not video_path.exists():
        print(f"❌ File not found: {video_path}", file=sys.stderr)
        sys.exit(1)

    slug = slug or slugify(video_path.name)
    episode_dir = Path(__file__).parent / "episodes" / slug
    episode_dir.mkdir(parents=True, exist_ok=True)
    output_path = episode_dir / "transcript.json"

    if output_path.exists() and not force:
        print(f"⏭️  Transcript already exists: {output_path}")
        print("   Use --force to re-transcribe.")
        return str(output_path)

    print(f"🎙️  Episode: {slug}")
    print(f"📁  File:    {video_path}")
    print(f"🤖  Model:   {model_name}")
    print(f"📝  Output:  {output_path}")
    print()

    # Load model (downloads on first run, cached after)
    print(f"⏳ Loading Whisper model '{model_name}'...")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    print("✅ Model loaded.\n")

    print("🔄 Transcribing with word-level timestamps...")
    segments_gen, info = model.transcribe(
        str(video_path),
        language="ar",          # Arabic — detect automatically if needed
        word_timestamps=True,
        beam_size=5,
        vad_filter=True,        # skip silence
        vad_parameters=dict(min_silence_duration_ms=500)
    )

    # Collect all segments (generator)
    segments = []
    words_all = []
    full_text_parts = []

    for seg in segments_gen:
        seg_words = []
        if seg.words:
            for w in seg.words:
                word_obj = {
                    "word": w.word,
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "probability": round(w.probability, 3)
                }
                seg_words.append(word_obj)
                words_all.append(word_obj)

        seg_obj = {
            "id": seg.id,
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text.strip(),
            "words": seg_words
        }
        segments.append(seg_obj)
        full_text_parts.append(seg.text.strip())
        # Live progress
        mins = int(seg.start // 60)
        secs = int(seg.start % 60)
        print(f"  [{mins:02d}:{secs:02d}] {seg.text.strip()[:80]}")

    full_text = " ".join(full_text_parts)
    duration = segments[-1]["end"] if segments else 0

    output = {
        "slug": slug,
        "source_file": str(video_path),
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration_seconds": round(duration, 3),
        "model": model_name,
        "word_count": len(words_all),
        "segment_count": len(segments),
        "full_text": full_text,
        "segments": segments,
        "words": words_all
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n✅ Done! {len(segments)} segments, {len(words_all)} words, {round(duration/60, 1)} min")
    print(f"📄 Saved: {output_path}")
    return str(output_path)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Transcribe episode with word-level timestamps")
    parser.add_argument("video", help="Path to video or audio file")
    parser.add_argument("--slug", help="Episode slug (default: derived from filename)")
    parser.add_argument("--model", default="large-v3", help="Whisper model size (default: large-v3)")
    parser.add_argument("--force", action="store_true", help="Re-transcribe even if output exists")
    args = parser.parse_args()

    transcribe(args.video, slug=args.slug, model_name=args.model, force=args.force)
