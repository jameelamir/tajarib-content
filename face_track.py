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
GAUSSIAN_SIGMA = 6.0  # smoothing width in samples (~3s look-ahead/behind at 0.5s intervals)

# Model path — look next to this script
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(SCRIPT_DIR, "blaze_face_short_range.tflite")


def detect_faces(video_path):
    """Sample frames from video and detect face center x-coordinates."""
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
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_interval == 0:
            t = frame_idx / fps

            # Convert BGR to RGB and create MediaPipe Image
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

            # Detect faces
            result = detector.detect(mp_image)

            if result.detections:
                # Use the most confident detection
                best = max(result.detections, key=lambda d: d.categories[0].score)
                bbox = best.bounding_box
                frame_h, frame_w = frame.shape[:2]
                # Face center x (normalized 0-1)
                cx = (bbox.origin_x + bbox.width / 2.0) / frame_w
                cx = max(0.0, min(1.0, cx))
                keyframes.append({"t": round(t, 3), "x": round(cx, 4)})
            else:
                # No face detected — mark as None for interpolation
                keyframes.append({"t": round(t, 3), "x": None})

        frame_idx += 1

    cap.release()
    detector.close()

    return keyframes


def fill_gaps(keyframes):
    """Fill None (no-face) keyframes by interpolating between neighbors."""
    if not keyframes:
        return [{"t": 0.0, "x": 0.5}]

    # Find first and last valid x
    valid = [kf for kf in keyframes if kf["x"] is not None]
    if not valid:
        # No faces detected at all — center fallback
        return [{"t": kf["t"], "x": 0.5} for kf in keyframes]

    # Fill leading Nones with first valid value
    first_valid = valid[0]["x"]
    last_valid = valid[-1]["x"]

    for kf in keyframes:
        if kf["x"] is not None:
            break
        kf["x"] = first_valid

    # Fill trailing Nones with last valid value
    for kf in reversed(keyframes):
        if kf["x"] is not None:
            break
        kf["x"] = last_valid

    # Fill interior Nones by linear interpolation
    i = 0
    while i < len(keyframes):
        if keyframes[i]["x"] is None:
            # Find next valid
            j = i + 1
            while j < len(keyframes) and keyframes[j]["x"] is None:
                j += 1
            # Interpolate between i-1 and j
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


def smooth(keyframes):
    """Apply dead zone + bidirectional Gaussian smoothing.

    Unlike EMA (which only looks backward and introduces lag), Gaussian smoothing
    is non-causal — it looks both ahead and behind each point, producing smooth
    curves without the camera "chasing" the face.

    Pipeline:
      Pass 1: Dead zone — collapse micro-jitter below DEAD_ZONE threshold
      Pass 2: Gaussian smooth (sigma=6 ≈ 3s look-ahead/behind at 0.5s intervals)
      Pass 3: Second Gaussian pass for extra cinematic smoothness
    """
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

    # Pass 2 & 3: double Gaussian for very smooth, lag-free curves
    # sigma=6 at 0.5s intervals = ~3 second look-ahead/behind window
    xs = _gaussian_smooth(xs, sigma=GAUSSIAN_SIGMA)
    xs = _gaussian_smooth(xs, sigma=GAUSSIAN_SIGMA)

    smoothed = []
    for i, kf in enumerate(dejittered):
        smoothed.append({"t": kf["t"], "x": round(xs[i], 4)})

    return smoothed


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
    keyframes = detect_faces(video_path)
    print(f"Sampled {len(keyframes)} frames, {sum(1 for kf in keyframes if kf['x'] is not None)} with faces")

    keyframes = fill_gaps(keyframes)
    keyframes = smooth(keyframes)

    result = {"keyframes": keyframes}

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(result, f, indent=2)

    print(f"Saved {len(keyframes)} keyframes to {output_path}")


if __name__ == "__main__":
    main()
