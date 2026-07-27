import { convertFileSrc } from "@tauri-apps/api/core";

/** Same density OpenChatCut / CapCut use for timeline audio. */
const PEAKS_PER_SECOND = 100;

export type PeakData = {
  peaks: Float32Array;
  peaksPerSecond: number;
  durationMs: number;
};

const cache = new Map<string, PeakData>();
const inflight = new Map<string, Promise<PeakData>>();

function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function cacheKey(path: string): string {
  return `v4:${PEAKS_PER_SECOND}:${path}`;
}

/** Decode once → time-indexed peak envelope (peaks/sec). */
export async function loadPeaks(path: string): Promise<PeakData> {
  const key = cacheKey(path);
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const job = (async (): Promise<PeakData> => {
    const url = convertFileSrc(path);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`waveform fetch ${res.status}`);
    const raw = await res.arrayBuffer();
    await yieldFrame();
    const ctx = new AudioContext();
    try {
      const audio = await ctx.decodeAudioData(raw.slice(0));
      await yieldFrame();
      const ch = audio.getChannelData(0);
      const durationMs = Math.max(1, Math.round(audio.duration * 1000));
      const buckets = Math.max(
        2,
        Math.ceil((durationMs / 1000) * PEAKS_PER_SECOND),
      );
      const peaks = new Float32Array(buckets);
      const block = Math.max(1, Math.floor(ch.length / buckets));
      const stride = Math.max(1, Math.floor(block / 48));
      for (let i = 0; i < buckets; i++) {
        let max = 0;
        const start = i * block;
        const end = Math.min(ch.length, start + block);
        for (let j = start; j < end; j += stride) {
          const v = Math.abs(ch[j]);
          if (v > max) max = v;
        }
        peaks[i] = max;
        if (i > 0 && i % 200 === 0) await yieldFrame();
      }
      let peak = 0.0001;
      for (let i = 0; i < peaks.length; i++) peak = Math.max(peak, peaks[i]);
      const inv = 1 / peak;
      for (let i = 0; i < peaks.length; i++) {
        peaks[i] = Math.min(1, peaks[i] * inv);
      }
      const data: PeakData = {
        peaks,
        peaksPerSecond: PEAKS_PER_SECOND,
        durationMs,
      };
      cache.set(key, data);
      return data;
    } finally {
      void ctx.close();
      inflight.delete(key);
    }
  })();

  inflight.set(key, job);
  return job;
}

/**
 * CapCut / OpenChatCut bar waveform:
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
