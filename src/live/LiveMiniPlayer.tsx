import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import {
  List,
  Pause,
  Play,
  Repeat,
  Repeat1,
  SkipBack,
  SkipForward,
} from "lucide-react";

type PickerPos = {
  left: number;
  width: number;
  maxHeight: number;
  /** 上弹：贴按钮上方；下弹：贴按钮下方 */
  top?: number;
  bottom?: number;
};

type BgmStatus = {
  path: string | null;
  playing: boolean;
  paused: boolean;
  positionMs: number;
  durationMs: number | null;
};

type LoopMode = "loopOne" | "loopList" | "shuffle";

type SfxLite = {
  myBgm: string[];
  bgmVolume: number;
  loopMode: LoopMode;
  itemMeta: Record<string, { displayName?: string; volume?: number }>;
  vinylArtDataUrl: string | null;
};

const EMPTY_BGM: BgmStatus = {
  path: null,
  playing: false,
  paused: false,
  positionMs: 0,
  durationMs: null,
};

function formatMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function folderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2]! : "";
}

type Props = {
  labels: {
    musicTitle: string;
    bgmIdle: string;
    prev: string;
    next: string;
    loopOne: string;
    loopList: string;
    playlist: string;
    playlistTitle: string;
    noPlaylist: string;
  };
};

export default function LiveMiniPlayer({ labels }: Props) {
  const [bgm, setBgm] = useState<BgmStatus>(EMPTY_BGM);
  const [sfx, setSfx] = useState<SfxLite>({
    myBgm: [],
    bgmVolume: 0.7,
    loopMode: "loopOne",
    itemMeta: {},
    vinylArtDataUrl: null,
  });
  const [seekDrag, setSeekDrag] = useState<number | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [pickerPos, setPickerPos] = useState<PickerPos | null>(null);
  const sfxRef = useRef(sfx);
  const listBtnRef = useRef<HTMLButtonElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  sfxRef.current = sfx;

  const placePicker = useCallback(() => {
    const btn = listBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = 280;
    const gap = 6;
    // 右边缘对齐选歌按钮
    const left = Math.min(
      Math.max(8, r.right - width),
      window.innerWidth - width - 8,
    );
    const spaceAbove = r.top - gap - 8;
    const spaceBelow = window.innerHeight - r.bottom - gap - 8;
    const openUp = spaceAbove >= 100 || spaceAbove >= spaceBelow;
    const maxHeight = Math.min(240, Math.max(120, openUp ? spaceAbove : spaceBelow));
    if (openUp) {
      // bottom 贴着按钮顶边 → 列表紧贴按钮上方
      setPickerPos({
        left,
        width,
        maxHeight,
        bottom: window.innerHeight - r.top + gap,
      });
    } else {
      setPickerPos({
        left,
        width,
        maxHeight,
        top: r.bottom + gap,
      });
    }
  }, []);

  const reloadMyBgm = useCallback(async () => {
    try {
      const store = await load("sfx.json", { autoSave: true });
      const raw = (await store.get<Partial<SfxLite>>("sfx")) ?? {};
      const myBgm = Array.isArray(raw.myBgm) ? raw.myBgm : [];
      const itemMeta =
        raw.itemMeta && typeof raw.itemMeta === "object" ? raw.itemMeta : {};
      setSfx((prev) => ({ ...prev, myBgm, itemMeta }));
      try {
        await invoke("sfx_set_playlist", { paths: myBgm });
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  }, []);

  const refreshBgm = useCallback(async () => {
    try {
      const st = await invoke<BgmStatus>("sfx_bgm_status");
      setBgm({
        path: st.path,
        playing: st.playing,
        paused: st.paused,
        positionMs: st.positionMs,
        durationMs: st.durationMs,
      });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await load("sfx.json", { autoSave: true });
        const raw = (await store.get<Partial<SfxLite>>("sfx")) ?? {};
        if (cancelled) return;
        const loopMode =
          raw.loopMode === "loopList" || raw.loopMode === "shuffle"
            ? raw.loopMode
            : "loopOne";
        const next: SfxLite = {
          myBgm: Array.isArray(raw.myBgm) ? raw.myBgm : [],
          bgmVolume: typeof raw.bgmVolume === "number" ? raw.bgmVolume : 0.7,
          loopMode,
          itemMeta: raw.itemMeta && typeof raw.itemMeta === "object" ? raw.itemMeta : {},
          vinylArtDataUrl:
            typeof raw.vinylArtDataUrl === "string" ? raw.vinylArtDataUrl : null,
        };
        setSfx(next);
        try {
          await invoke("sfx_set_playlist", { paths: next.myBgm });
          await invoke("sfx_set_loop_mode", { mode: next.loopMode });
          await invoke("sfx_set_bgm_volume", { volume: next.bgmVolume });
        } catch {
          /* ignore */
        }
      } catch {
        /* ignore */
      }
      await refreshBgm();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshBgm]);

  useEffect(() => {
    const id = window.setInterval(() => void refreshBgm(), 400);
    return () => window.clearInterval(id);
  }, [refreshBgm]);

  const playBgm = useCallback(
    async (path: string) => {
      const volume = sfxRef.current.itemMeta[path]?.volume ?? 1;
      try {
        await invoke("sfx_set_playlist", { paths: sfxRef.current.myBgm });
        await invoke("sfx_play_bgm", { path, volume });
        await refreshBgm();
      } catch {
        /* ignore */
      }
    },
    [refreshBgm],
  );

  const skipBgm = useCallback(
    async (delta: number) => {
      const list = sfxRef.current.myBgm;
      if (!list.length) return;
      const cur = bgm.path;
      const idx = cur ? list.indexOf(cur) : -1;
      const next =
        idx < 0 ? (delta > 0 ? 0 : list.length - 1) : (idx + delta + list.length) % list.length;
      await playBgm(list[next]!);
    },
    [bgm.path, playBgm],
  );

  const toggleLoop = useCallback(async () => {
    const next: LoopMode = sfxRef.current.loopMode === "loopList" ? "loopOne" : "loopList";
    setSfx((prev) => ({ ...prev, loopMode: next }));
    try {
      await invoke("sfx_set_loop_mode", { mode: next });
      const store = await load("sfx.json", { autoSave: true });
      const raw = (await store.get<Record<string, unknown>>("sfx")) ?? {};
      await store.set("sfx", { ...raw, loopMode: next });
    } catch {
      /* ignore */
    }
  }, []);

  const trackName = useMemo(() => {
    if (!bgm.path) return labels.bgmIdle;
    const meta = sfx.itemMeta[bgm.path]?.displayName?.trim();
    return meta || fileName(bgm.path);
  }, [bgm.path, sfx.itemMeta, labels.bgmIdle]);

  const trackArtist = useMemo(() => {
    if (!bgm.path) return labels.musicTitle;
    return folderName(bgm.path) || labels.musicTitle;
  }, [bgm.path, labels.musicTitle]);

  useLayoutEffect(() => {
    if (!listOpen) {
      setPickerPos(null);
      return;
    }
    placePicker();
    const onWin = () => placePicker();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [listOpen, placePicker, sfx.myBgm.length]);

  useEffect(() => {
    if (!listOpen) return;
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node;
      if (listBtnRef.current?.contains(t)) return;
      if (pickerRef.current?.contains(t)) return;
      setListOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setListOpen(false);
    };
    // 下一帧再听，避免本次点击按钮时立刻被关掉
    const timer = window.setTimeout(() => {
      document.addEventListener("pointerdown", onDoc, true);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onDoc, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [listOpen]);

  const picker =
    listOpen && pickerPos
      ? createPortal(
          <div
            ref={pickerRef}
            className="live-mini-picker-pop"
            role="listbox"
            aria-label={labels.playlistTitle}
            style={{
              left: pickerPos.left,
              width: pickerPos.width,
              maxHeight: pickerPos.maxHeight,
              ...(pickerPos.bottom != null
                ? { bottom: pickerPos.bottom }
                : { top: pickerPos.top }),
            }}
          >
            <div className="live-mini-picker-head">{labels.playlistTitle}</div>
            {sfx.myBgm.length === 0 ? (
              <p className="muted live-mini-picker-empty">{labels.noPlaylist}</p>
            ) : (
              <div className="live-mini-list">
                {sfx.myBgm.map((path, i) => {
                  const name =
                    sfx.itemMeta[path]?.displayName?.trim() || fileName(path);
                  const on = bgm.path === path;
                  return (
                    <button
                      key={path}
                      type="button"
                      role="option"
                      aria-selected={on}
                      className={on ? "on" : undefined}
                      onClick={() => {
                        void playBgm(path);
                        setListOpen(false);
                      }}
                    >
                      <span>{i + 1}</span>
                      <span title={name}>{name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <section className={listOpen ? "live-mini-player open" : "live-mini-player"}>
      <div className="live-mini-top">
        <div
          className={
            bgm.playing && !bgm.paused
              ? "live-mini-vinyl spinning"
              : bgm.paused
                ? "live-mini-vinyl paused"
                : "live-mini-vinyl"
          }
          aria-hidden
        >
          <div className="live-mini-disk">
            {sfx.vinylArtDataUrl ? (
              <img src={sfx.vinylArtDataUrl} alt="" draggable={false} />
            ) : (
              <svg viewBox="0 0 128 128">
                <rect width="128" height="128" fill="#0a0a0a" />
                <circle cx="20" cy="22" r="1.4" fill="#fff" opacity="0.5" />
                <circle cx="48" cy="16" r="1.2" fill="#fff" opacity="0.35" />
                <circle cx="96" cy="28" r="1.3" fill="#fff" opacity="0.45" />
                <path
                  d="M0 128 Q32 64 64 128 T128 128"
                  fill="var(--accent)"
                  opacity="0.9"
                />
                <path
                  d="M0 128 Q32 40 64 128 T128 128"
                  fill="var(--accent)"
                  opacity="0.55"
                />
              </svg>
            )}
            <span className="live-mini-spindle" />
          </div>
        </div>
        <div className="live-mini-meta">
          <div className="live-mini-name" title={trackName}>
            {trackName}
          </div>
          <div className="live-mini-artist" title={trackArtist}>
            {trackArtist}
          </div>
        </div>
      </div>

      <div className="live-mini-seek">
        <span>{formatMs(seekDrag ?? bgm.positionMs)}</span>
        <input
          type="range"
          min={0}
          max={Math.max(bgm.durationMs ?? 0, 1)}
          step={100}
          disabled={!bgm.path || !bgm.durationMs}
          value={seekDrag ?? Math.min(bgm.positionMs, bgm.durationMs ?? 0)}
          onChange={(e) => setSeekDrag(Number(e.target.value))}
          onMouseUp={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            setSeekDrag(null);
            void invoke("sfx_seek_bgm", { positionMs: v }).then(() => refreshBgm());
          }}
          onTouchEnd={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            setSeekDrag(null);
            void invoke("sfx_seek_bgm", { positionMs: v }).then(() => refreshBgm());
          }}
        />
        <span>{bgm.durationMs != null ? formatMs(bgm.durationMs) : "--:--"}</span>
      </div>

      <div className="live-mini-controls">
        <button
          type="button"
          title={sfx.loopMode === "loopList" ? labels.loopList : labels.loopOne}
          className={sfx.loopMode === "loopList" ? "on" : undefined}
          onClick={() => void toggleLoop()}
        >
          {sfx.loopMode === "loopList" ? (
            <Repeat size={18} strokeWidth={1.75} absoluteStrokeWidth />
          ) : (
            <Repeat1 size={18} strokeWidth={1.75} absoluteStrokeWidth />
          )}
        </button>
        <button
          type="button"
          title={labels.prev}
          disabled={sfx.myBgm.length === 0}
          onClick={() => void skipBgm(-1)}
        >
          <SkipBack size={18} strokeWidth={1.75} absoluteStrokeWidth fill="currentColor" />
        </button>
        <button
          type="button"
          className="live-mini-play"
          disabled={!bgm.path && sfx.myBgm.length === 0}
          onClick={() =>
            void (async () => {
              try {
                if (!bgm.path) {
                  if (sfx.myBgm[0]) await playBgm(sfx.myBgm[0]);
                  return;
                }
                if (bgm.paused) await invoke("sfx_resume_bgm");
                else if (bgm.playing) await invoke("sfx_pause_bgm");
                else await playBgm(bgm.path);
                await refreshBgm();
              } catch {
                /* ignore */
              }
            })()
          }
        >
          {bgm.playing && !bgm.paused ? (
            <Pause size={18} strokeWidth={0} absoluteStrokeWidth fill="currentColor" />
          ) : (
            <Play
              size={18}
              strokeWidth={0}
              absoluteStrokeWidth
              fill="currentColor"
              style={{ marginLeft: 2 }}
            />
          )}
        </button>
        <button
          type="button"
          title={labels.next}
          disabled={sfx.myBgm.length === 0}
          onClick={() => void skipBgm(1)}
        >
          <SkipForward size={18} strokeWidth={1.75} absoluteStrokeWidth fill="currentColor" />
        </button>
        <button
          ref={listBtnRef}
          type="button"
          title={labels.playlist}
          aria-label={labels.playlist}
          aria-expanded={listOpen}
          className={listOpen ? "on" : undefined}
          onClick={() => {
            if (listOpen) {
              setListOpen(false);
              return;
            }
            placePicker();
            setListOpen(true);
            void reloadMyBgm();
          }}
        >
          <List size={18} strokeWidth={1.75} absoluteStrokeWidth />
        </button>
      </div>
      {picker}
    </section>
  );
}
