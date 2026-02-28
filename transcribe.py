#!/usr/bin/env python3
"""
Step 1: Transcribe an episode video/audio file using faster-whisper (local) or Haimaker API.
Outputs word-level timestamped transcript to episodes/{slug}/transcript.json

Usage:
  python3 transcribe.py <video_file> [--slug my-episode] [--model large-v3] [--force] [--api]

Environment:
  HAIMAKER_API_KEY - Required for API mode
"""

import argparse
import json
import os
import sys
import re
import time
from pathlib import Path

try:
    from faster_whisper import WhisperModel
    HAS_LOCAL = True
except ImportError:
    HAS_LOCAL = False

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

def slugify(name):
    """Create a filesystem-safe slug from a filename."""
    name = Path(name).stem
    name = re.sub(r'[^\w\s-]', '', name)
    name = re.sub(r'[\s_]+', '-', name.strip())
    return name

def load_api_key():
    """Load Haimaker API key from main agent config or environment."""
    # Try environment first
    api_key = os.environ.get('HAIMAKER_API_KEY')
    if api_key:
        return api_key
    
    # Try main agent models.json (same key used by Jassim)
    main_agent_config = Path("/root/.openclaw/agents/main/agent/models.json")
    if main_agent_config.exists():
        try:
            config = json.loads(main_agent_config.read_text())
            return config.get('providers', {}).get('haimaker', {}).get('apiKey')
        except:
            pass
    
    # Try transcription-specific config (user override)
    config_path = Path(__file__).parent / "transcription-config.json"
    if config_path.exists():
        try:
            config = json.loads(config_path.read_text())
            return config.get('apiKey') or config.get('haimakerApiKey')
        except:
            pass
    
    return None

def transcribe_with_api(video_path, api_key, language="ar"):
    """Transcribe using Haimaker API with Whisper Large."""
    if not HAS_REQUESTS:
        raise ImportError("requests library not installed. Run: pip install requests")
    
    BASE_URL = "https://api.haimaker.ai/v1"
    
    print(f"🌐 Using Haimaker API for transcription...")
    print(f"📁 Uploading: {video_path}")
    
    # Upload and transcribe
    with open(video_path, 'rb') as f:
        # First, upload the file
        files = {'file': (Path(video_path).name, f, 'audio/mpeg')}
        
        print("⏳ Uploading to API...")
        
        # Try the audio/transcriptions endpoint
        try:
            response = requests.post(
                f"{BASE_URL}/audio/transcriptions",
                headers={"Authorization": f"Bearer {api_key}"},
                files=files,
                data={
                    "model": "whisper-large-v3",
                    "language": language,
                    "response_format": "verbose_json",
                    "timestamp_granularities": ["word", "segment"]
                },
                timeout=300
            )
        except requests.exceptions.ConnectionError:
            print("❌ Could not connect to Haimaker API. Check your internet connection.", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"❌ API request failed: {e}", file=sys.stderr)
            sys.exit(1)
    
    if response.status_code != 200:
        print(f"❌ API Error {response.status_code}: {response.text}", file=sys.stderr)
        sys.exit(1)
    
    result = response.json()
    
    # Convert to our format
    segments = []
    words_all = []
    
    for seg in result.get('segments', []):
        seg_words = []
        for w in seg.get('words', []):
            word_obj = {
                "word": w.get('word', ''),
                "start": round(w.get('start', 0), 3),
                "end": round(w.get('end', 0), 3),
                "probability": round(w.get('probability', 1.0), 3)
            }
            seg_words.append(word_obj)
            words_all.append(word_obj)
        
        seg_obj = {
            "id": seg.get('id', 0),
            "start": round(seg.get('start', 0), 3),
            "end": round(seg.get('end', 0), 3),
            "text": seg.get('text', '').strip(),
            "words": seg_words
        }
        segments.append(seg_obj)
    
    full_text = result.get('text', '').strip()
    duration = segments[-1]["end"] if segments else 0
    
    output = {
        "slug": None,  # Will be set by caller
        "source_file": str(video_path),
        "language": result.get('language', language),
        "language_probability": 1.0,
        "duration_seconds": round(duration, 3),
        "model": "whisper-large-v3-api",
        "word_count": len(words_all),
        "segment_count": len(segments),
        "full_text": full_text,
        "segments": segments,
        "words": words_all,
        "api_provider": "haimaker"
    }
    
    return output

def transcribe_local(video_path, model_name="large-v3"):
    """Transcribe using local faster-whisper."""
    if not HAS_LOCAL:
        raise ImportError("faster-whisper not installed. Run: pip install faster-whisper")
    
    print(f"🤖 Using local Whisper model: {model_name}")
    
    # Load model
    print(f"⏳ Loading Whisper model '{model_name}'...")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    print("✅ Model loaded.\n")
    
    print("🔄 Transcribing with word-level timestamps...")
    segments_gen, info = model.transcribe(
        str(video_path),
        language="ar",
        word_timestamps=True,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500)
    )
    
    # Collect segments
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
        "slug": None,
        "source_file": str(video_path),
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration_seconds": round(duration, 3),
        "model": model_name,
        "word_count": len(words_all),
        "segment_count": len(segments),
        "full_text": full_text,
        "segments": segments,
        "words": words_all,
        "api_provider": "local"
    }
    
    return output

def transcribe(video_path, slug=None, model_name="large-v3", force=False, use_api=False):
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
    print(f"📝  Output:  {output_path}")
    print()
    
    # Transcribe
    if use_api:
        api_key = load_api_key()
        if not api_key:
            print("❌ No API key found! Set HAIMAKER_API_KEY environment variable or configure via dashboard.", file=sys.stderr)
            print("   You can get an API key from: https://haimaker.ai", file=sys.stderr)
            sys.exit(1)
        
        try:
            result = transcribe_with_api(video_path, api_key)
        except Exception as e:
            print(f"❌ API transcription failed: {e}", file=sys.stderr)
            print("   Falling back to local transcription...", file=sys.stderr)
            result = transcribe_local(video_path, model_name)
    else:
        result = transcribe_local(video_path, model_name)
    
    result["slug"] = slug
    
    # Save output
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    
    print(f"\n✅ Done! {result['segment_count']} segments, {result['word_count']} words, {round(result['duration_seconds']/60, 1)} min")
    print(f"📄 Saved: {output_path}")
    print(f"🔌 Provider: {result.get('api_provider', 'local')}")
    
    return str(output_path)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Transcribe episode with word-level timestamps")
    parser.add_argument("video", help="Path to video or audio file")
    parser.add_argument("--slug", help="Episode slug (default: derived from filename)")
    parser.add_argument("--model", default="large-v3", help="Whisper model size (default: large-v3)")
    parser.add_argument("--force", action="store_true", help="Re-transcribe even if output exists")
    parser.add_argument("--api", action="store_true", help="Use Haimaker API instead of local model")
    args = parser.parse_args()
    
    transcribe(args.video, slug=args.slug, model_name=args.model, force=args.force, use_api=args.api)
