# 🎬 Local-First Cutting Guide

Cut your videos **locally** first, then upload just the clips. This saves 90-99% server space.

---

## Quick Method: Use the Script

```bash
node cut-and-upload.js your-video.mp4 00:05:30 45 reel-muhannad-quote
```

**Parameters:**
1. Video file path
2. Start time (HH:MM:SS or seconds)
3. Duration in seconds
4. Slug name for the reel

Or run without arguments for interactive mode:
```bash
node cut-and-upload.js
```

---

## Manual Method: ffmpeg

If you prefer manual control, use ffmpeg directly:

### 1. Cut your clip locally

```bash
ffmpeg -ss 00:05:30 -i "big-interview.mp4" -t 45 \
  -c:v libx264 -preset fast -crf 23 \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  "reel-muhannad-quote.mp4"
```

**What this does:**
- `-ss 00:05:30` = Start at 5 minutes 30 seconds
- `-t 45` = Cut 45 seconds
- Result: A 45-second clip (maybe 10-20MB instead of 30GB!)

### 2. Upload to dashboard

In the dashboard:
1. Select **"Reel (cut, no subs)"** mode
2. Drag your cut clip
3. Add guest name & role
4. Upload

The dashboard will:
- Transcribe the short clip (fast!)
- Generate captions
- Add subtitles
- Ready to publish

---

## Example Workflow

**Scenario:** 2-hour podcast (25GB), you want 3 clips

```bash
# Clip 1: The hook (first 30 seconds)
ffmpeg -ss 00:00:00 -i podcast.mp4 -t 30 reel-hook.mp4

# Clip 2: Best quote at 12:45
ffmpeg -ss 00:12:45 -i podcast.mp4 -t 60 reel-best-quote.mp4

# Clip 3: Final thoughts at 1:45:00
ffmpeg -ss 01:45:00 -i podcast.mp4 -t 45 reel-final-thoughts.mp4

# Total: 3 clips ≈ 45MB instead of 25GB = 99.8% space saved!
```

Then upload each as "Reel (cut, no subs)" in the dashboard.

---

## Pro Tips

1. **Find timestamps first:** Watch your video, note down good timestamps
2. **Quick preview:** Use `ffplay -ss 00:05:30 -t 10 big-video.mp4` to preview 10 seconds
3. **Batch cut:** Make a script with multiple ffmpeg commands for all your clips
4. **Quality:** `-crf 23` is good balance. Lower = better quality, bigger file

---

## When to Use Which Mode

| Mode | Use when | Server storage |
|------|----------|----------------|
| **Episode** | Full podcast episode | High (keeps everything) |
| **Reel (cut, no subs)** | You cut locally, just need subtitles | Low (just the clip) |
| **Reel (fully done)** | Clip is 100% ready, just publishing | Low |

**Recommendation:** Use "Reel (cut, no subs)" for maximum space efficiency.
