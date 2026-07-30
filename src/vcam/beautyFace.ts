/**
 * MediaPipe Face Landmarker — face-only mask for beauty.
 * Confirms face detection is alive; mask is soft face oval (eyes/lips lightly protected).
 */

import {
  FaceLandmarker,
  FilesetResolver,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
];
const LEFT_EYE = [
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
];
const RIGHT_EYE = [
  362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384,
  398,
];
const LIPS = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317,
  14, 87, 178, 88, 95, 185, 40, 39, 37, 0, 267, 269, 270, 409, 415, 310, 311,
  312, 13, 82, 81, 42, 183, 78,
];

let landmarkerPromise: Promise<FaceLandmarker | null> | null = null;
let lastError = "";
let lastHasFace = false;

export function getFaceDetectError(): string {
  return lastError;
}

export function getLastHasFace(): boolean {
  return lastHasFace;
}

function publicUrl(rel: string): string {
  return new URL(
    rel.replace(/^\//, ""),
    window.location.origin + (import.meta.env.BASE_URL || "/"),
  ).href;
}

export function ensureFaceLandmarker(): Promise<FaceLandmarker | null> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const tryCreate = async (delegate: "GPU" | "CPU") => {
        const vision = await FilesetResolver.forVisionTasks(
          publicUrl("mediapipe/wasm"),
        );
        return FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: publicUrl("models/face_landmarker.task"),
            delegate,
          },
          runningMode: "VIDEO",
          numFaces: 1,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      };
      try {
        lastError = "";
        const lm = await tryCreate("GPU");
        console.info("[beauty-face] FaceLandmarker ready (GPU)");
        return lm;
      } catch (e1) {
        try {
          lastError = "";
          const lm = await tryCreate("CPU");
          console.info("[beauty-face] FaceLandmarker ready (CPU)");
          return lm;
        } catch (e2) {
          lastError = String(e2 || e1);
          console.error("[beauty-face] FaceLandmarker FAILED", e2 || e1);
          return null;
        }
      }
    })();
  }
  return landmarkerPromise;
}

function fillPoly(
  ctx: CanvasRenderingContext2D,
  lms: NormalizedLandmark[],
  indices: number[],
  w: number,
  h: number,
) {
  ctx.beginPath();
  let started = false;
  for (const idx of indices) {
    const p = lms[idx];
    if (!p) continue;
    const x = p.x * w;
    const y = p.y * h;
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * Face oval with forehead expanded upward (MediaPipe oval is tight on brow/forehead).
 * Upper points push up by ~12% of face height so 美白/磨皮 cover forehead.
 */
function fillFaceOvalWithForehead(
  ctx: CanvasRenderingContext2D,
  lms: NormalizedLandmark[],
  w: number,
  h: number,
) {
  const top = lms[10];
  const chin = lms[152];
  const faceH =
    top && chin ? Math.max(8, Math.abs((chin.y - top.y) * h)) : h * 0.4;
  const expandUp = faceH * 0.14;
  const topY = top ? top.y * h : 0;

  ctx.beginPath();
  let started = false;
  for (const idx of FACE_OVAL) {
    const p = lms[idx];
    if (!p) continue;
    let x = p.x * w;
    let y = p.y * h;
    // Upper 45% of face: push outline up (strongest at brow/forehead)
    const rel = (y - topY) / faceH;
    if (rel < 0.45) {
      const t = 1 - rel / 0.45;
      y -= expandUp * t * t;
    }
    // Slight lateral expand so temples aren't cut
    if (rel < 0.55) {
      const midX = ((lms[10]?.x ?? 0.5) + (lms[152]?.x ?? 0.5)) * 0.5 * w;
      const side = Math.min(1, Math.abs(x - midX) / (w * 0.18));
      x += (x >= midX ? 1 : -1) * faceH * 0.03 * side;
    }
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * Build soft face mask (white = face, black = background) into maskCanvas.
 * Forehead is expanded; eyes/lips lightly protected.
 */
export function buildFaceMask(
  maskCanvas: HTMLCanvasElement,
  lms: NormalizedLandmark[],
  w: number,
  h: number,
): void {
  if (maskCanvas.width !== w || maskCanvas.height !== h) {
    maskCanvas.width = w;
    maskCanvas.height = h;
  }
  const ctx = maskCanvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  fillFaceOvalWithForehead(ctx, lms, w, h);
  // Protect eyes & lips a bit (less plastic)
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgba(0,0,0,0.75)";
  fillPoly(ctx, lms, LEFT_EYE, w, h);
  fillPoly(ctx, lms, RIGHT_EYE, w, h);
  fillPoly(ctx, lms, LIPS, w, h);
  ctx.globalCompositeOperation = "source-over";
  // Soft edge (slightly softer so forehead/cheek transition isn't hard)
  const blurPx = Math.max(8, Math.round(Math.min(w, h) * 0.022));
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.filter = "none";
}

export type FaceDetectResult = {
  hasFace: boolean;
  landmarks: NormalizedLandmark[] | null;
  error: string;
};

/**
 * Detect face on a video frame (MediaPipe VIDEO mode).
 */
export async function detectFace(
  video: HTMLVideoElement,
  timestampMs: number,
): Promise<FaceDetectResult> {
  const lm = await ensureFaceLandmarker();
  if (!lm) {
    lastHasFace = false;
    return { hasFace: false, landmarks: null, error: lastError || "模型未加载" };
  }
  try {
    const res = lm.detectForVideo(video, timestampMs);
    const face = res.faceLandmarks?.[0];
    if (face && face.length > 0) {
      lastHasFace = true;
      return { hasFace: true, landmarks: face, error: "" };
    }
    lastHasFace = false;
    return { hasFace: false, landmarks: null, error: "" };
  } catch (e) {
    lastError = String(e);
    lastHasFace = false;
    return { hasFace: false, landmarks: null, error: lastError };
  }
}
