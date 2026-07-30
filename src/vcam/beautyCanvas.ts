/**
 * Face-aware beauty:
 * MediaPipe face mask + (WebGL|CPU) beauty layer + face-only composite.
 * Background is NEVER full-screen blurred/bleached.
 */

import {
  buildFaceMask,
  detectFace,
  ensureFaceLandmarker,
  getFaceDetectError,
} from "./beautyFace";
import {
  getBeautyGLError,
  paintBeautyWebGL,
  resetBeautyGL,
} from "./beautyWebGL";

export type BeautyCanvasParams = {
  enabled: boolean;
  smooth: number;
  whiten: number;
  slim: number;
};

let lastError = "";
let engineHint = "人脸美颜";
let glFailCount = 0;

let rawCanvas: HTMLCanvasElement | null = null;
let beautyCanvas: HTMLCanvasElement | null = null;
let maskCanvas: HTMLCanvasElement | null = null;
let glStageCanvas: HTMLCanvasElement | null = null;

let holdMaskFrames = 0;

export function getBeautyLandmarkerError(): string {
  return lastError || getFaceDetectError() || getBeautyGLError();
}

export function getBeautyEngineHint(): string {
  return engineHint;
}

export function getFaceLandmarker(): Promise<unknown> {
  return ensureFaceLandmarker();
}

function ensureCanvas(
  cur: HTMLCanvasElement | null,
  w: number,
  h: number,
): HTMLCanvasElement {
  const c = cur ?? document.createElement("canvas");
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c;
}

function yuv(r: number, g: number, b: number): [number, number, number] {
  const y = 0.3 * r + 0.587 * g + 0.114 * b;
  return [y, (0.5 * (b - y)) / 0.886, (0.5 * (r - y)) / 0.701];
}

function cpuBeauty(
  src: ImageData,
  smooth: number,
  whiten: number,
): ImageData {
  const w = src.width;
  const h = src.height;
  const a = src.data;
  const s = Math.max(0, Math.min(1, smooth));
  const wh = Math.max(0, Math.min(1, whiten)) * 1.15;
  const doSmooth = s > 0.015;
  const selfW = 16 - s * 6;
  const yTh = 0.05 + s * 0.06;
  const uvTh = 0.028 + s * 0.035;
  const rad = s > 0.45 ? 2 : 1;
  const out = new ImageData(w, h);
  const d = out.data;
  d.set(a);

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const o = (j * w + i) * 4;
      const r0 = a[o]! / 255;
      const g0 = a[o + 1]! / 255;
      const b0 = a[o + 2]! / 255;
      const [cy] = yuv(r0, g0, b0);
      let rr = r0;
      let gg = g0;
      let bb = b0;
      if (doSmooth) {
        let sr = r0 * selfW;
        let sg = g0 * selfW;
        let sb = b0 * selfW;
        let wt = selfW;
        const [cu, cv] = (() => {
          const y = 0.3 * r0 + 0.587 * g0 + 0.114 * b0;
          return [(0.5 * (b0 - y)) / 0.886, (0.5 * (r0 - y)) / 0.701];
        })();
        for (let dj = -rad; dj <= rad; dj++) {
          for (let di = -rad; di <= rad; di++) {
            if (di === 0 && dj === 0) continue;
            const ii = Math.max(0, Math.min(w - 1, i + di));
            const jj = Math.max(0, Math.min(h - 1, j + dj));
            const t = (jj * w + ii) * 4;
            const r = a[t]! / 255;
            const g = a[t + 1]! / 255;
            const b = a[t + 2]! / 255;
            const [y, u, v] = yuv(r, g, b);
            const edge =
              Math.abs(y - cy) / yTh > 1.1 ||
              Math.abs(u - cu) / uvTh > 1.1 ||
              Math.abs(v - cv) / uvTh > 1.1;
            if (edge) {
              sr += r0;
              sg += g0;
              sb += b0;
            } else {
              sr += r;
              sg += g;
              sb += b;
            }
            wt += 1;
          }
        }
        const softR = sr / wt;
        const softG = sg / wt;
        const softB = sb / wt;
        // keep high fully; blend mid kill gently
        const blend = s * s * 0.5 + s * 0.3;
        rr = r0 * (1 - blend) + (softR + (r0 - softR) * 1.05) * blend;
        gg = g0 * (1 - blend) + (softG + (g0 - softG) * 1.05) * blend;
        bb = b0 * (1 - blend) + (softB + (b0 - softB) * 1.05) * blend;
      }
      if (wh > 0.015) {
        const toneW = 0.62 + 0.38 * (1 - cy * cy);
        const amount = wh * toneW;
        rr = Math.min(1, rr * (1 + amount * 0.18));
        gg = Math.min(1, gg * (1 + amount * 0.18));
        bb = Math.min(1, bb * (1 + amount * 0.18));
        rr = rr * (1 - amount * 0.12) + 1.0 * amount * 0.12;
        gg = gg * (1 - amount * 0.12) + 0.99 * amount * 0.12;
        bb = bb * (1 - amount * 0.12) + 0.97 * amount * 0.12;
      }
      d[o] = (Math.min(1, Math.max(0, rr)) * 255) | 0;
      d[o + 1] = (Math.min(1, Math.max(0, gg)) * 255) | 0;
      d[o + 2] = (Math.min(1, Math.max(0, bb)) * 255) | 0;
      d[o + 3] = 255;
    }
  }
  return out;
}

function compositeFaceOnly(
  rawData: ImageData,
  beautyData: ImageData,
  maskData: ImageData,
  stage: HTMLCanvasElement,
): boolean {
  const w = rawData.width;
  const h = rawData.height;
  if (beautyData.width !== w || maskData.width !== w) return false;
  const out = new ImageData(w, h);
  const rd = rawData.data;
  const bd = beautyData.data;
  const md = maskData.data;
  const od = out.data;
  for (let i = 0; i < od.length; i += 4) {
    const a = md[i]! / 255;
    od[i] = rd[i]! * (1 - a) + bd[i]! * a;
    od[i + 1] = rd[i + 1]! * (1 - a) + bd[i + 1]! * a;
    od[i + 2] = rd[i + 2]! * (1 - a) + bd[i + 2]! * a;
    od[i + 3] = 255;
  }
  if (stage.width !== w || stage.height !== h) {
    stage.width = w;
    stage.height = h;
  }
  const ctx = stage.getContext("2d");
  if (!ctx) return false;
  ctx.putImageData(out, 0, 0);
  return true;
}

export async function paintBeautyFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  params: BeautyCanvasParams,
  maxWidth = 960,
  timestampMs?: number,
): Promise<{ hasFace: boolean; ready: boolean }> {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw < 2 || video.readyState < 2) {
    return { hasFace: false, ready: false };
  }

  let tw = vw;
  let th = vh;
  if (tw > maxWidth) {
    th = Math.max(2, Math.round((vh * maxWidth) / vw));
    tw = maxWidth;
  }
  tw &= ~1;
  th &= ~1;

  rawCanvas = ensureCanvas(rawCanvas, tw, th);
  const rctx = rawCanvas.getContext("2d", { willReadFrequently: true });
  if (!rctx) {
    engineHint = "失败";
    return { hasFace: false, ready: false };
  }
  rctx.drawImage(video, 0, 0, tw, th);
  const rawData = rctx.getImageData(0, 0, tw, th);

  // Beauty off / both sliders at bottom → original (no quality loss path)
  if (!params.enabled || (params.smooth <= 0.015 && params.whiten <= 0.015)) {
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width = tw;
      canvas.height = th;
    }
    canvas.getContext("2d")?.drawImage(rawCanvas, 0, 0);
    engineHint = "人脸美颜";
    return { hasFace: false, ready: true };
  }

  // —— 1) Face recognition (MediaPipe) ——
  const det = await detectFace(video, timestampMs ?? performance.now());
  maskCanvas = ensureCanvas(maskCanvas, tw, th);

  if (det.hasFace && det.landmarks) {
    buildFaceMask(maskCanvas, det.landmarks, tw, th);
    holdMaskFrames = 8;
  } else if (holdMaskFrames > 0) {
    holdMaskFrames--;
    // keep previous mask pixels
  } else {
    // No face → original only (never full-screen filter)
    if (canvas.width !== tw || canvas.height !== th) {
      canvas.width = tw;
      canvas.height = th;
    }
    canvas.getContext("2d")?.drawImage(rawCanvas, 0, 0);
    engineHint = det.error ? "人脸模型失败" : "未检测到人脸";
    lastError = det.error;
    return { hasFace: false, ready: true };
  }

  // —— 2) Beauty layer ——
  beautyCanvas = ensureCanvas(beautyCanvas, tw, th);
  let beautyData: ImageData | null = null;
  let via = "";

  if (glFailCount < 5) {
    glStageCanvas = ensureCanvas(
      glStageCanvas,
      video.videoWidth,
      video.videoHeight,
    );
    const ok = paintBeautyWebGL(video, glStageCanvas, {
      smooth: params.smooth,
      whiten: params.whiten,
    });
    if (ok) {
      glFailCount = 0;
      const bctx = beautyCanvas.getContext("2d", { willReadFrequently: true });
      bctx?.drawImage(glStageCanvas, 0, 0, tw, th);
      beautyData = bctx?.getImageData(0, 0, tw, th) ?? null;
      via = "GPU";
    } else {
      glFailCount++;
      if (glFailCount === 2) resetBeautyGL();
      lastError = getBeautyGLError();
    }
  }

  if (!beautyData) {
    beautyData = cpuBeauty(rawData, params.smooth, params.whiten);
    via = "CPU";
  }

  // —— 3) Face-only composite ——
  const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
  const maskData = mctx?.getImageData(0, 0, tw, th);
  if (!maskData) {
    engineHint = "蒙版失败";
    return { hasFace: true, ready: true };
  }

  const ok = compositeFaceOnly(rawData, beautyData, maskData, canvas);
  if (!ok) {
    canvas.getContext("2d")?.drawImage(rawCanvas, 0, 0);
    engineHint = "合成失败";
    return { hasFace: true, ready: true };
  }

  engineHint = `已锁定人脸·${via}`;
  lastError = "";
  return { hasFace: true, ready: true };
}
