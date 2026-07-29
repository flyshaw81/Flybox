import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** Timeline density: enough for zoom, far cheaper than full decode. */
const PEAKS_PER_SECOND = 48;

export type PeakData = {
  peaks: Float32Array;
  peaksPerSecond: number;
  durationMs: number;
};

const cache = new Map<string, PeakData>();
const inflight = new Map<string, Promise<PeakData>>();

function cacheKey(path: string, buckets: number): string {
  return `v5:${buckets}:${path}`;
}

function bucketCount(durationMs: number): number {
  const sec = Math.max(0.5, durationMs / 1000);
  return Math.min(4096, Math.max(128, Math.ceil(sec * PEAKS_PER_SECOND)));
}

function toPeakData(
  raw: number[] | Float32Array,
  durationMs: number,
): PeakData {
  const n = raw.length;
  const peaks = new Float32Array(n);
  let peak = 0.0001;
  for (let i = 0; i < n; i++) {
    const v = raw[i] ?? 0;
    if (v > peak) peak = v;
  }
  const inv = 1 / peak;
  for (let i = 0; i < n; i++) {
    peaks[i] = Math.min(1, (raw[i] ?? 0) * inv);
  }
  const dur = Math.max(1, durationMs);
  return {
    peaks,
    peaksPerSecond: peaks.length / (dur / 1000),
    durationMs: dur,
  };
}

/** Prefer native ffmpeg peaks (8kHz + disk cache); browser decode only as fallback. */
export async function loadPeaks(
  path: string,
  durationHintMs?: number | null,
): Promise<PeakData> {
  const hint = durationHintMs && durationHintMs > 0 ? durationHintMs : 0;
  const buckets = bucketCount(hint || 60_000);
  const key = cacheKey(path, buckets);
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const job = (async (): Promise<PeakData> => {
    // 1) 后端：快 + 可缓存
    try {
      const peaks = await invoke<number[]>("sfx_waveform", {
        path,
        buckets,
      });
      let durationMs = hint;
      if (!durationMs) {
        try {
          const info = await invoke<{ durationMs?: number | null }>("sfx_probe", {
            path,
          });
          durationMs = info.durationMs ?? 0;
        } catch {
          /* ignore */
        }
      }
      if (!durationMs) {
        // 粗估：按 48 峰/秒反推
        durationMs = Math.max(1, Math.round((peaks.length / PEAKS_PER_SECOND) * 1000));
      }
      const data = toPeakData(peaks, durationMs);
      cache.set(key, data);
      return data;
    } catch {
      /* fall through to browser */
    }

    // 2) 浏览器备用：全文件解码（慢），加大步长、少 yield
    const url = convertFileSrc(path);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`waveform fetch ${res.status}`);
    const raw = await res.arrayBuffer();
    const ctx = new AudioContext();
    try {
      const audio = await ctx.decodeAudioData(raw.slice(0));
      const ch = audio.getChannelData(0);
      const durationMs = Math.max(1, Math.round(audio.duration * 1000));
      const nBuckets = bucketCount(durationMs);
      const peaks = new Float32Array(nBuckets);
      const block = Math.max(1, Math.floor(ch.length / nBuckets));
      const stride = Math.max(1, Math.floor(block / 32));
      for (let i = 0; i < nBuckets; i++) {
        let max = 0;
        const start = i * block;
        const end = Math.min(ch.length, start + block);
        for (let j = start; j < end; j += stride) {
          const v = Math.abs(ch[j]);
          if (v > max) max = v;
        }
        peaks[i] = max;
      }
      const data = toPeakData(peaks, durationMs);
      cache.set(cacheKey(path, nBuckets), data);
      return data;
    } finally {
      void ctx.close();
      inflight.delete(key);
    }
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/**
 * CapCut-style bar waveform:
 * one vertical stroke every ~2px; each column = max peak in that time window.
 */
export function peaksSvgPath(
  data: PeakData,
  width: number,
  height: number,
  srcStartMs: number,
  srcEndMs: number,
): string {
  const { peaks, peaksPerSecond, durationMs } = data;
  const n = peaks.length;
  if (n < 2 || width <= 1 || height <= 1 || durationMs <= 0) return "";

  const mediaMs = durationMs;
  const startMs = Math.max(0, Math.min(mediaMs, srcStartMs));
  const endMs = Math.max(startMs + 1, Math.min(mediaMs, srcEndMs));
  const startIdx = (startMs / 1000) * peaksPerSecond;
  const spanIdx = ((endMs - startMs) / 1000) * peaksPerSecond;

  const cols = Math.max(1, Math.min(2000, Math.floor(width / 2)));
  const mid = height / 2;
  const out: string[] = [];

  for (let c = 0; c < cols; c++) {
    const from = startIdx + (c / cols) * spanIdx;
    const to = startIdx + ((c + 1) / cols) * spanIdx;
    const lo = Math.max(0, Math.floor(from));
    const hi = Math.min(n - 1, Math.max(lo, Math.ceil(to) - 1));
    let peak = 0;
    for (let i = lo; i <= hi; i++) {
      if (peaks[i] > peak) peak = peaks[i];
    }
    const amp = Math.max(0.5, peak * (mid - 0.5));
    const x = ((c + 0.5) / cols) * width;
    out.push(
      `M${x.toFixed(1)} ${(mid - amp).toFixed(1)}V${(mid + amp).toFixed(1)}`,
    );
  }
  return out.join(" ");
}
