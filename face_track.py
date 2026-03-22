#!/usr/bin/env python3
"""
Face tracking for smart crop — detects face positions across video frames.

Usage:
    python3 face_track.py <input_video> <output_json>

Output JSON format:
    { "keyframes": [{"t": 0.0, "x": 0.45}, {"t": 0.5, "x": 0.48}, ...] }

x values are normalized (0.0 = left edge, 1.0 = right edge).
Falls back to x=0.5 (center) if no face is detected.
"""

import sys
import json
import os
import math

def check_dependencies():
    """Check and report missing dependencies."""
    missing = []
    try:
        import cv2
    except ImportError:
        missing.append("opencv-python-headless")
    try:
        import mediapipe
    except ImportError:
        missing.append("mediapipe")
    if missing:
        print(f"Missing dependencies: {', '.join(missing)}", file=sys.stderr)
        print(f"Install with: pip3 install {' '.join(missing)}", file=sys.stderr)
        sys.exit(1)

check_dependencies()

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision


SAMPLE_INTERVAL = 0.5  # seconds between frame samples
DEAD_ZONE = 0.025  # moves smaller than this are completely ignored (higher = less jitter)
GAUSSIAN_SIGMA = 5.0  # smoothing width in samples (~2.5s look-ahead/behind at 0.5s intervals)

# Model path — look next to this script
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(SCRIPT_DIR, "blaze_face_short_range.tflite")


SCENE_CUT_THRESHOLD = 0.4  # histogram correlation below this = scene cut


def _detect_face_tiled(frame, detector, frame_w, frame_h):
    """Fallback for wide shots: scan overlapping tiles to find small faces.

    When BlazeFace can't detect faces in the full frame (too small/far),
    we crop into overlapping halves and run detection on each tile,
    mapping coordinates back to full frame.
    """
    tile_w = frame_w // 2
    tiles = [
        (0, tile_w),                    # left half
        (frame_w // 4, frame_w // 4 + tile_w),  # center half
        (frame_w - tile_w, frame_w),    # right half
    ]

    best_score = 0
    best_cx = None

    for (x1, x2) in tiles:
        tile = frame[:, x1:x2]
        rgb = cv2.cvtColor(tile, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = detector.detect(mp_image)

        if result.detections:
            det = max(result.detections, key=lambda d: d.categories[0].score)
            score = det.categories[0].score
            if score > best_score:
                bbox = det.bounding_box
                # Map tile-local x back to full frame
                tile_cx = bbox.origin_x + bbox.width / 2.0
                full_cx = (x1 + tile_cx) / frame_w
                best_score = score
                best_cx = max(0.0, min(1.0, full_cx))

    return best_cx


def detect_faces(video_path):
    """Sample frames from video and detect face positions + scene cuts."""
    if not os.path.exists(MODEL_PATH):
        print(f"Face detection model not found at: {MODEL_PATH}", file=sys.stderr)
        print("Download from: https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite", file=sys.stderr)
        sys.exit(1)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Cannot open video: {video_path}", file=sys.stderr)
        sys.exit(1)

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0
    frame_interval = max(1, int(fps * SAMPLE_INTERVAL))

    print(f"Video: {duration:.1f}s, {fps:.0f}fps, sampling every {SAMPLE_INTERVAL}s")

    # Create face detector using Tasks API (MediaPipe 0.10+)
    base_options = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
    options = vision.FaceDetectorOptions(
        base_options=base_options,
        min_detection_confidence=0.5
    )
    detector = vision.FaceDetector.create_from_options(options)

    keyframes = []
    cuts = []  # precise timestamps where scene cuts are detected
    prev_hist = None
    last_cut_frame = -999  # prevent duplicate cuts within MIN_CUT_GAP frames
    MIN_CUT_GAP = int(fps * 0.3)  # at least 0.3s between cuts
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        t = frame_idx / fps

        # Scene cut detection on EVERY frame (cheap — just histogram comparison)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        hist = cv2.calcHist([gray], [0], None, [256], [0, 256])
        hist = cv2.normalize(hist, hist).flatten()
        is_cut = False
        if prev_hist is not None and (frame_idx - last_cut_frame) > MIN_CUT_GAP:
            corr = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL)
            if corr < SCENE_CUT_THRESHOLD:
                cuts.append(round(t, 3))
                last_cut_frame = frame_idx
                is_cut = True
        prev_hist = hist

        # Face detection at sample intervals AND at scene cuts (immediate response)
        if frame_idx % frame_interval == 0 or is_cut:
            frame_h, frame_w = frame.shape[:2]
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = detector.detect(mp_image)

            if result.detections:
                best = max(result.detections, key=lambda d: d.categories[0].score)
                bbox = best.bounding_box
                cx = (bbox.origin_x + bbox.width / 2.0) / frame_w
                cx = max(0.0, min(1.0, cx))
                keyframes.append({"t": round(t, 3), "x": round(cx, 4)})
            else:
                # Full-frame detection failed — try tiled detection for wide shots
                cx = _detect_face_tiled(frame, detector, frame_w, frame_h)
                if cx is not None:
                    keyframes.append({"t": round(t, 3), "x": round(cx, 4)})
                else:
                    keyframes.append({"t": round(t, 3), "x": None})

        frame_idx += 1

    cap.release()
    detector.close()

    if cuts:
        print(f"Detected {len(cuts)} scene cuts at: {cuts}")

    return keyframes, cuts, fps


def _split_at_cuts(keyframes, cuts):
    """Split keyframes into segments at scene cut boundaries.

    Cuts have precise per-frame timestamps that may not align with keyframe
    sample times. Splits at the first keyframe at or after each cut.
    """
    if not cuts:
        return [keyframes]
    segments = []
    current = []
    cut_idx = 0
    for kf in keyframes:
        if cut_idx < len(cuts) and kf["t"] >= cuts[cut_idx]:
            if current:
                segments.append(current)
            current = [kf]
            cut_idx += 1
        else:
            current.append(kf)
    if current:
        segments.append(current)
    return segments


def _fill_gaps_segment(keyframes, fallback_x=0.5):
    """Fill None (no-face) keyframes within a single segment."""
    if not keyframes:
        return [{"t": 0.0, "x": fallback_x}]

    valid = [kf for kf in keyframes if kf["x"] is not None]
    if not valid:
        # No faces in this segment — use fallback (last known position)
        return [{"t": kf["t"], "x": fallback_x} for kf in keyframes]

    first_valid = valid[0]["x"]
    last_valid = valid[-1]["x"]

    for kf in keyframes:
        if kf["x"] is not None:
            break
        kf["x"] = first_valid

    for kf in reversed(keyframes):
        if kf["x"] is not None:
            break
        kf["x"] = last_valid

    i = 0
    while i < len(keyframes):
        if keyframes[i]["x"] is None:
            j = i + 1
            while j < len(keyframes) and keyframes[j]["x"] is None:
                j += 1
            x_start = keyframes[i - 1]["x"]
            x_end = keyframes[j]["x"]
            t_start = keyframes[i - 1]["t"]
            t_end = keyframes[j]["t"]
            for k in range(i, j):
                frac = (keyframes[k]["t"] - t_start) / (t_end - t_start) if t_end != t_start else 0
                keyframes[k]["x"] = round(x_start + (x_end - x_start) * frac, 4)
            i = j
        else:
            i += 1

    return keyframes


def fill_gaps(keyframes, cuts):
    """Fill None keyframes by interpolating — independently within each segment.

    When a segment has no face detections (e.g. wide shot), carries forward the
    last known face position from the previous segment instead of centering.
    """
    segments = _split_at_cuts(keyframes, cuts)
    result = []
    last_valid_x = 0.5
    for seg in segments:
        filled = _fill_gaps_segment(seg, fallback_x=last_valid_x)
        result.extend(filled)
        # Track last valid face position across segments
        valid_in_seg = [kf for kf in seg if kf["x"] is not None]
        if valid_in_seg:
            last_valid_x = valid_in_seg[-1]["x"]
    return result


def _gaussian_kernel(sigma):
    """Build a normalized 1D Gaussian kernel."""
    half_w = int(sigma * 3)
    kernel = []
    for i in range(-half_w, half_w + 1):
        kernel.append(math.exp(-0.5 * (i / sigma) ** 2))
    total = sum(kernel)
    return [k / total for k in kernel], half_w


def _gaussian_smooth(xs, sigma):
    """Apply non-causal (bidirectional) Gaussian smoothing to a list of floats."""
    kernel, half_w = _gaussian_kernel(sigma)
    n = len(xs)
    out = []
    for i in range(n):
        val = 0.0
        weight = 0.0
        for j, k in enumerate(kernel):
            idx = i + (j - half_w)
            # Clamp to edges instead of ignoring — avoids shrinking at boundaries
            idx = max(0, min(n - 1, idx))
            val += xs[idx] * k
            weight += k
        out.append(val / weight if weight > 0 else xs[i])
    return out


def _smooth_segment(keyframes):
    """Apply dead zone + bidirectional Gaussian smoothing to a single segment."""
    if len(keyframes) <= 1:
        return keyframes

    # Pass 1: dead zone — replace tiny jitters with previous value
    dejittered = [keyframes[0].copy()]
    for i in range(1, len(keyframes)):
        prev_x = dejittered[-1]["x"]
        raw_x = keyframes[i]["x"]
        if abs(raw_x - prev_x) < DEAD_ZONE:
            dejittered.append({"t": keyframes[i]["t"], "x": prev_x})
        else:
            dejittered.append(keyframes[i].copy())

    xs = [kf["x"] for kf in dejittered]

    # Double Gaussian for smooth, lag-free curves (within this segment only)
    xs = _gaussian_smooth(xs, sigma=GAUSSIAN_SIGMA)
    xs = _gaussian_smooth(xs, sigma=GAUSSIAN_SIGMA)

    smoothed = []
    for i, kf in enumerate(dejittered):
        smoothed.append({"t": kf["t"], "x": round(xs[i], 4)})

    return smoothed


def smooth(keyframes, cuts):
    """Apply smoothing independently within each segment (never across scene cuts)."""
    segments = _split_at_cuts(keyframes, cuts)
    result = []
    for seg in segments:
        result.extend(_smooth_segment(seg))
    return result


def _detect_implicit_cuts(keyframes, existing_cuts, jump_threshold=0.2, min_gap=0.6):
    """Detect camera changes missed by histogram-based cut detection.

    When the histogram doesn't change enough (e.g. similar lighting between shots),
    a large face position jump between consecutive samples indicates a camera switch.
    """
    implicit = []
    for i in range(1, len(keyframes)):
        if keyframes[i]["x"] is None or keyframes[i - 1]["x"] is None:
            continue
        jump = abs(keyframes[i]["x"] - keyframes[i - 1]["x"])
        if jump >= jump_threshold:
            t = keyframes[i]["t"]
            if not any(abs(t - c) < min_gap for c in existing_cuts):
                implicit.append(t)
    return implicit


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 face_track.py <input_video> <output_json>", file=sys.stderr)
        sys.exit(1)

    video_path = sys.argv[1]
    output_path = sys.argv[2]

    if not os.path.exists(video_path):
        print(f"Video not found: {video_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Detecting faces in: {os.path.basename(video_path)}")
    keyframes, cuts, fps = detect_faces(video_path)
    print(f"Sampled {len(keyframes)} frames, {sum(1 for kf in keyframes if kf['x'] is not None)} with faces")

    keyframes = fill_gaps(keyframes, cuts)

    # Detect camera changes missed by histogram-based cut detection
    implicit = _detect_implicit_cuts(keyframes, cuts)
    if implicit:
        print(f"Detected {len(implicit)} implicit cuts from face position jumps: {implicit}")
        cuts = sorted(cuts + implicit)

    keyframes = smooth(keyframes, cuts)

    result = {"keyframes": keyframes, "cuts": cuts, "fps": round(fps, 3)}

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(result, f, indent=2)

    print(f"Saved {len(keyframes)} keyframes to {output_path}")


if __name__ == "__main__":
    main()
