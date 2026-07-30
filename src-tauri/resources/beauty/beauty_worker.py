#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Quality face beauty for virtual-cam output.
MediaPipe landmarks + edge-preserving smooth + highlight-safe whitening.
No face → pass-through. No center-ellipse fake mask.
"""

from __future__ import annotations

import os
import struct
import sys
import tempfile
import urllib.request

import cv2
import numpy as np
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
NOSE, LCHEEK, RCHEEK = 1, 234, 454


def ensure_model() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    for p in [
        os.path.join(here, "face_landmarker.task"),
        os.path.normpath(
            os.path.join(here, "..", "..", "resources", "beauty", "face_landmarker.task")
        ),
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


def poly(h, w, lms, indices):
    pts = []
    for i in indices:
        if i < len(lms):
            pts.append([int(lms[i].x * w), int(lms[i].y * h)])
    if len(pts) < 3:
        return None
    m = np.zeros((h, w), np.float32)
    cv2.fillConvexPoly(m, cv2.convexHull(np.array(pts, np.int32)), 1.0)
    return m


def skin_mask(h, w, lms, bgr):
    face = poly(h, w, lms, FACE_OVAL)
    if face is None:
        return None, w * 0.5
    for group in (LEFT_EYE, RIGHT_EYE, LEFT_BROW, RIGHT_BROW, LIPS):
        hole = poly(h, w, lms, group)
        if hole is not None:
            face = np.clip(face - hole, 0, 1)
    k = max(5, int(min(h, w) * 0.025) | 1)
    face = cv2.GaussianBlur(face, (k, k), 0)
    # mild YCrCb skin preference
    ycrcb = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)
    y, cr, cb = cv2.split(ycrcb)
    tone = ((cr > 130) & (cr < 175) & (cb > 75) & (cb < 130) & (y > 40)).astype(np.float32)
    tone = cv2.GaussianBlur(tone, (k, k), 0)
    mask = np.clip(face * (0.45 + 0.55 * tone), 0, 1)
    cx = (lms[NOSE].x + lms[LCHEEK].x + lms[RCHEEK].x) / 3.0 * w
    return mask, cx


def beauty_frame(rgba, landmarker, smooth, whiten, slim):
    h, w = rgba.shape[:2]
    bgr = cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGR)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    result = landmarker.detect(
        vision.Image(image_format=vision.ImageFormat.SRGB, data=rgb)
    )
    if not result.face_landmarks:
        return rgba

    mask, cx = skin_mask(h, w, result.face_landmarks[0], bgr)
    if mask is None:
        return rgba
    m3 = mask[..., None]
    out = bgr.astype(np.float32)

    # subtle slim
    if slim > 0.02:
        map_x = np.tile(np.arange(w, dtype=np.float32), (h, 1))
        map_y = np.tile(np.arange(h, dtype=np.float32)[:, None], (1, w))
        map_x = map_x - (map_x - cx) * (min(0.22, slim * 0.18) * mask)
        out = cv2.remap(
            np.clip(out, 0, 255).astype(np.uint8),
            map_x,
            map_y,
            cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        ).astype(np.float32)

    # edge-preserving smooth (bilateral + residual mix, not pure fog)
    if smooth > 0.02:
        s = min(0.85, smooth)
        d = 5 + int(s * 8)
        if d % 2 == 0:
            d += 1
        sigma = 30 + s * 55
        src_u = np.clip(out, 0, 255).astype(np.uint8)
        blur = cv2.bilateralFilter(src_u, d, sigma, sigma).astype(np.float32)
        # edge protect via residual magnitude
        resid = np.abs(out - blur).mean(axis=2, keepdims=True)
        edge = np.clip(resid / 18.0, 0, 1)
        k = (s * 0.7) * m3 * (1.0 - edge * 0.85)
        out = out * (1.0 - k) + blur * k

    # highlight-safe whitening
    if whiten > 0.02:
        wamt = min(0.7, whiten)
        lab = cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB).astype(
            np.float32
        )
        L, A, B = cv2.split(lab)
        # protect highlights
        hi = np.clip((L - 170.0) / 40.0, 0, 1)
        lift = wamt * 22.0 * mask * (1.0 - hi)
        L = np.clip(L + lift, 0, 255)
        lab = cv2.merge([L, A, B]).astype(np.uint8)
        white = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR).astype(np.float32)
        out = out * (1.0 - m3) + white * m3

    return cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_BGR2RGBA)


def read_exact(n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            raise EOFError
        buf.extend(chunk)
    return bytes(buf)


def main() -> int:
    try:
        landmarker = make_landmarker()
    except Exception as e:
        sys.stderr.write(f"init fail: {e}\n")
        return 2
    sys.stderr.write("beauty_worker ready (quality face pipeline)\n")
    sys.stderr.flush()
    while True:
        head = read_exact(4)
        if head == QUIT:
            return 0
        if head != MAGIC:
            return 3
        w, h = struct.unpack("<II", read_exact(8))
        smooth, whiten, slim = struct.unpack("<fff", read_exact(12))
        raw = read_exact(w * h * 4)
        rgba = np.frombuffer(raw, np.uint8).reshape((h, w, 4)).copy()
        try:
            out = beauty_frame(rgba, landmarker, smooth, whiten, slim)
        except Exception as e:
            sys.stderr.write(f"frame: {e}\n")
            out = rgba
        sys.stdout.buffer.write(MAGIC + struct.pack("<II", w, h))
        sys.stdout.buffer.write(np.ascontiguousarray(out).tobytes())
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except EOFError:
        raise SystemExit(0)
