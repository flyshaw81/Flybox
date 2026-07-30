#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Face-only beauty for FLYBOX virtual camera.
MediaPipe face mask + frequency-separation 磨皮 + forehead-safe 美白.

Protocol FB01:
  in:  FB01 | u32 w | u32 h | f32 smooth | f32 whiten | f32 slim | RGBA
  out: FB01 | u32 w | u32 h | RGBA
"""

from __future__ import annotations

import os
import struct
import sys
import tempfile
import urllib.request

import cv2
import numpy as np
from mediapipe import Image as MpImage
from mediapipe import ImageFormat as MpImageFormat
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core import base_options as mp_base

MAGIC = b"FB01"
QUIT = b"QUIT"
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "face_landmarker/face_landmarker/float16/1/face_landmarker.task"
)

FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
    378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
    162, 21, 54, 103, 67, 109,
]
LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
LEFT_BROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
RIGHT_BROW = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]
LIPS = [
    61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317,
    14, 87, 178, 88, 95, 185, 40, 39, 37, 0, 267, 269, 270, 409, 415, 310, 311,
    312, 13, 82, 81, 42, 183, 78,
]


def ensure_model() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    for p in [
        os.path.join(here, "face_landmarker.task"),
        os.path.join(tempfile.gettempdir(), "flybox_face_landmarker.task"),
    ]:
        if os.path.isfile(p) and os.path.getsize(p) > 100_000:
            return p
    dest = os.path.join(tempfile.gettempdir(), "flybox_face_landmarker.task")
    urllib.request.urlretrieve(MODEL_URL, dest)
    return dest


def make_landmarker():
    opts = vision.FaceLandmarkerOptions(
        base_options=mp_base.BaseOptions(model_asset_path=ensure_model()),
        num_faces=1,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return vision.FaceLandmarker.create_from_options(opts)


def poly_pts(h, w, lms, indices):
    pts = []
    for i in indices:
        if i < len(lms):
            pts.append([int(lms[i].x * w), int(lms[i].y * h)])
    return pts


def face_soft_mask(h, w, lms):
    """Soft face mask; forehead expanded (MediaPipe oval is tight on brow)."""
    pts = poly_pts(h, w, lms, FACE_OVAL)
    if len(pts) < 3:
        return None

    top = lms[10] if len(lms) > 10 else None
    chin = lms[152] if len(lms) > 152 else None
    face_h = abs((chin.y - top.y) * h) if top and chin else h * 0.4
    face_h = max(8.0, face_h)
    expand_up = face_h * 0.16
    top_y = top.y * h if top else 0.0
    mid_x = ((top.x if top else 0.5) + (chin.x if chin else 0.5)) * 0.5 * w

    exp = []
    for x, y in pts:
        yy = float(y)
        xx = float(x)
        rel = (yy - top_y) / face_h
        if rel < 0.48:
            t = 1.0 - rel / 0.48
            yy -= expand_up * t * t
        if rel < 0.55:
            side = min(1.0, abs(xx - mid_x) / max(w * 0.16, 1.0))
            xx += (1.0 if xx >= mid_x else -1.0) * face_h * 0.035 * side
        exp.append([int(xx), int(yy)])

    face = np.zeros((h, w), np.float32)
    cv2.fillConvexPoly(face, cv2.convexHull(np.array(exp, np.int32)), 1.0)

    for group in (LEFT_EYE, RIGHT_EYE, LEFT_BROW, RIGHT_BROW, LIPS):
        hole_pts = poly_pts(h, w, lms, group)
        if len(hole_pts) >= 3:
            hole = np.zeros((h, w), np.float32)
            cv2.fillConvexPoly(hole, cv2.convexHull(np.array(hole_pts, np.int32)), 1.0)
            face = np.clip(face - hole * 0.85, 0, 1)

    k = max(15, int(min(h, w) * 0.04) | 1)
    face = cv2.GaussianBlur(face, (k, k), 0)
    return np.clip(face, 0, 1)


def retouch_skin(rgb: np.ndarray, smooth: float, whiten: float) -> np.ndarray:
    """
    Frequency-separation 磨皮 (Photoshop-style):
      high  = fine texture (pores) — ALWAYS keep
      mid   = blemishes / uneven blotches — reduce by smooth
      low   = skin tone structure — keep
    smooth=0 → bitwise identical to input (no smooth pass).
    """
    out = rgb
    s = float(np.clip(smooth, 0.0, 1.0))
    wh = float(np.clip(whiten, 0.0, 1.0))

    # Hard gate: slider at bottom = zero smooth, no residual bilateral
    if s > 0.015:
        # Scale sigmas with face size so 720p/1080p feel similar
        m = float(min(out.shape[0], out.shape[1]))
        # high-pass base (fine detail)
        sigma_hi = max(0.6, m * 0.0012)
        # low structure
        sigma_lo = max(3.5, m * 0.012) * (0.75 + 0.55 * s)

        o = out.astype(np.float32)
        # Gaussian is separable & preserves mean tone better than bilateral fog
        hi_base = cv2.GaussianBlur(o, (0, 0), sigmaX=sigma_hi, sigmaY=sigma_hi)
        lo = cv2.GaussianBlur(o, (0, 0), sigmaX=sigma_lo, sigmaY=sigma_lo)

        high = o - hi_base          # pores / micro texture
        mid = hi_base - lo          # blemish-scale blotches

        # Kill mid-frequency only; high always ~100%
        mid_keep = 1.0 - s * 0.85   # s=1 → keep 15% of blotches
        # Slight high boost so face doesn't go soft after mid kill
        high_gain = 1.0 + s * 0.12

        retouched = lo + mid * mid_keep + high * high_gain
        # Gentle strength curve (not linear full replace at mid slider)
        blend = s * s * 0.55 + s * 0.35  # 0..0.9, softer at low end
        out = np.clip(o * (1.0 - blend) + retouched * blend, 0, 255).astype(np.uint8)

    if wh > 0.015:
        lab = cv2.cvtColor(out, cv2.COLOR_RGB2LAB).astype(np.float32)
        L = lab[:, :, 0]
        amount = wh * 1.15
        boost = amount * (8.0 + (255.0 - L) * 0.032)
        lab[:, :, 0] = np.clip(L + boost, 0, 255)
        lab[:, :, 1] = np.clip(lab[:, :, 1] + amount * 0.9, 0, 255)
        lab[:, :, 2] = np.clip(lab[:, :, 2] + amount * 2.0, 0, 255)
        out = cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2RGB)

    return out


def read_exact(stream, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            raise EOFError("pipe closed")
        buf.extend(chunk)
    return bytes(buf)


def main():
    sys.stderr.write("beauty_face_worker starting\n")
    sys.stderr.flush()
    landmarker = make_landmarker()
    sys.stderr.write("beauty_face_worker ready (freq-sep+face mask)\n")
    sys.stderr.flush()

    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    while True:
        magic = stdin.read(4)
        if not magic or magic == QUIT:
            break
        if magic != MAGIC:
            sys.stderr.write(f"bad magic {magic!r}\n")
            break
        w, h = struct.unpack("<II", read_exact(stdin, 8))
        smooth, whiten, slim = struct.unpack("<fff", read_exact(stdin, 12))
        _ = slim
        n = w * h * 4
        rgba = read_exact(stdin, n)

        try:
            # Early out: both off → original (no detect cost, no quality loss)
            if float(smooth) <= 0.015 and float(whiten) <= 0.015:
                stdout.write(MAGIC + struct.pack("<II", w, h) + rgba)
                stdout.flush()
                continue

            arr = np.frombuffer(bytearray(rgba), dtype=np.uint8).reshape(h, w, 4)
            rgb = np.ascontiguousarray(arr[:, :, :3])

            mp_image = MpImage(
                image_format=MpImageFormat.SRGB,
                data=rgb,
            )
            result = landmarker.detect(mp_image)
            if not result.face_landmarks:
                out = rgba
            else:
                lms = result.face_landmarks[0]
                mask = face_soft_mask(h, w, lms)
                if mask is None:
                    out = rgba
                else:
                    beauty_rgb = retouch_skin(rgb, smooth, whiten)
                    # If only whiten and retouch is nearly same as rgb for smooth=0,
                    # still blend only face (correct product).
                    o = arr.astype(np.float32)
                    b = beauty_rgb.astype(np.float32)
                    m = mask[:, :, None]
                    blended = o.copy()
                    blended[:, :, :3] = o[:, :, :3] * (1.0 - m) + b * m
                    out = np.clip(blended, 0, 255).astype(np.uint8).tobytes()
        except Exception as e:
            sys.stderr.write(f"beauty fail: {e}\n")
            out = rgba

        stdout.write(MAGIC + struct.pack("<II", w, h) + out)
        stdout.flush()

    sys.stderr.write("beauty_face_worker exit\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(f"fatal: {e}\n")
        sys.exit(1)
