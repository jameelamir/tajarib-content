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
SMOOTHING_ALPHA_LARGE = 0.20  # smoothing for large movements (lower = smoother)
SMOOTHING_ALPHA_SMALL = 0.008 # smoothing for small movements (barely reacts — very smooth)
SMALL_MOVE_THRESHOLD = 0.06  # normalized units — moves below this are "small"
DEAD_ZONE = 0.025  # moves smaller than this are completely ignored (higher = less jitter)

# Model path — look next to this script
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(SCRIPT_DIR, "blaze_face_short_range.tflite")


def detect_faces(video_path, prefer_side=None):
    """Sample frames from video and detect face center x-coordinates.
    prefer_side: 'left', 'right', or None (default: pick largest face)."""
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
                frame_h, frame_w = frame.shape[:2]
                if len(result.detections) > 1 and prefer_side:
                    # Multiple faces: prefer the one on the specified side
                    def side_score(d):
                        cx = (d.bounding_box.origin_x + d.bounding_box.width / 2.0) / frame_w
                        return cx if prefer_side == 'right' else (1.0 - cx)
                    best = max(result.detections, key=side_score)
                else:
                    # Single face or no preference: pick the largest face (closest to camera)
                    best = max(result.detections, key=lambda d: d.bounding_box.width * d.bounding_box.height)
                bbox = best.bounding_box
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


def smooth(keyframes):
    """Apply Gaussian smoothing (non-causal) for cinema-quality panning.
    Unlike EMA which only looks backward, Gaussian looks ahead and behind,
    producing genuinely smooth curves without lag or overshoot."""
    if len(keyframes) <= 1:
        return keyframes

    n = len(keyframes)
    xs = [kf["x"] for kf in keyframes]

    # Pass 1: dead zone — collapse tiny jitters to previous value
    dejittered = [xs[0]]
    for i in range(1, n):
        if abs(xs[i] - dejittered[-1]) < DEAD_ZONE:
            dejittered.append(dejittered[-1])
        else:
            dejittered.append(xs[i])

    # Pass 2: Gaussian smooth — sigma=6 samples = ~3 seconds of look-ahead/behind
    sigma = 6.0
    half_w = int(sigma * 3)  # kernel radius
    kernel = [math.exp(-0.5 * (i / sigma) ** 2) for i in range(-half_w, half_w + 1)]

    gaussian = []
    for i in range(n):
        weighted_sum = 0.0
        weight_sum = 0.0
        for j in range(-half_w, half_w + 1):
            idx = i + j
            if 0 <= idx < n:
                w = kernel[j + half_w]
                weighted_sum += dejittered[idx] * w
                weight_sum += w
        gaussian.append(weighted_sum / weight_sum)

    # Pass 3: second Gaussian pass for extra smoothness (double-smooth)
    double_smoothed = []
    for i in range(n):
        weighted_sum = 0.0
        weight_sum = 0.0
        for j in range(-half_w, half_w + 1):
            idx = i + j
            if 0 <= idx < n:
                w = kernel[j + half_w]
                weighted_sum += gaussian[idx] * w
                weight_sum += w
        double_smoothed.append(weighted_sum / weight_sum)

    return [{"t": keyframes[i]["t"], "x": round(double_smoothed[i], 4)} for i in range(n)]


def main():
    # Parse args: face_track.py <input_video> <output_json> [--prefer left|right]
    args = sys.argv[1:]
    prefer_side = None
    if "--prefer" in args:
        idx = args.index("--prefer")
        if idx + 1 < len(args):
            prefer_side = args[idx + 1]
            args = args[:idx] + args[idx + 2:]
        else:
            print("--prefer requires 'left' or 'right'", file=sys.stderr)
            sys.exit(1)

    if len(args) != 2:
        print("Usage: python3 face_track.py <input_video> <output_json> [--prefer left|right]", file=sys.stderr)
        sys.exit(1)

    video_path = args[0]
    output_path = args[1]

    if not os.path.exists(video_path):
        print(f"Video not found: {video_path}", file=sys.stderr)
        sys.exit(1)

    mode = f"prefer {prefer_side}" if prefer_side else "largest face"
    print(f"Detecting faces in: {os.path.basename(video_path)} ({mode})")
    keyframes = detect_faces(video_path, prefer_side=prefer_side)
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
