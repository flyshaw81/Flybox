import { useMemo, useState, type ReactNode } from "react";
import { Keyboard, Pause, Pencil, Play, Search, Trash2 } from "lucide-react";

export type HotkeyBinding = {
  id: string;
  label: string;
  hotkey: string;
  kind: "stop" | "sfx";
};

type Props = {
  bindings: HotkeyBinding[];
  selectedId: string | null;
  capturing: boolean;
  previewHotkey: string | null;
  playing: Record<string, number>;
  onSelect: (id: string) => void;
  onStartCapture: (id?: string) => void;
  onClear: (id: string) => void;
  onTogglePlay: (id: string) => void;
  onVirtualCommit: (hotkey: string) => void;
  t: (key: string) => string;
};

type ModState = { ctrl: boolean; alt: boolean; shift: boolean };

function parseHotkey(hk: string): { mods: Set<string>; key: string } {
  const parts = hk.split("+").filter(Boolean);
  if (parts.length === 0) return { mods: new Set(), key: "" };
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  return { mods, key };
}

function buildHotkey(mods: ModState, key: string): string | null {
  if (!key) return null;
  const parts: string[] = [];
  if (mods.ctrl) parts.push("Ctrl");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function keyMatches(hotkey: string | null | undefined, token: string): boolean {
  if (!hotkey) return false;
  const { mods, key } = parseHotkey(hotkey);
  const t = token.toLowerCase();
  if (t === "ctrl" || t === "control") return mods.has("ctrl");
  if (t === "alt") return mods.has("alt");
  if (t === "shift") return mods.has("shift");
  return key.toLowerCase() === t;
}

function KeyCap({
  label,
  className,
  lit,
  active,
  bound,
  title,
  onClick,
}: {
  label: ReactNode;
  className?: string;
  lit?: boolean;
  active?: boolean;
  bound?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      className={[
        "sfx-vk-key",
        className || "",
        bound ? "bound" : "",
        lit ? "lit" : "",
        active ? "active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export default function SfxHotkeysPanel({
  bindings,
  selectedId,
  capturing,
  previewHotkey,
  playing,
  onSelect,
  onStartCapture,
  onClear,
  onTogglePlay,
  onVirtualCommit,
  t,
}: Props) {
  const [mods, setMods] = useState<ModState>({ ctrl: true, alt: false, shift: false });
  const [query, setQuery] = useState("");

  const selected = bindings.find((b) => b.id === selectedId) ?? null;
  const highlightHk = capturing
    ? previewHotkey || selected?.hotkey || null
    : selected?.hotkey || null;

  const sfxCount = useMemo(
    () => bindings.filter((b) => b.kind === "sfx").length,
    [bindings],
  );

  const boundWithKeys = useMemo(
    () => bindings.filter((b) => Boolean(b.hotkey)),
    [bindings],
  );

  // 列表只显示音效；停止快捷键在设置里改，不混进列表
  const sfxBindings = useMemo(
    () => bindings.filter((b) => b.kind === "sfx"),
    [bindings],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sfxBindings;
    return sfxBindings.filter(
      (b) =>
        b.label.toLowerCase().includes(q) ||
        b.hotkey.toLowerCase().includes(q),
    );
  }, [sfxBindings, query]);

  /** 只亮主键，避免 Ctrl 被所有绑定点亮 */
  const boundPrimaryKeys = useMemo(() => {
    const set = new Set<string>();
    for (const b of boundWithKeys) {
      const { key } = parseHotkey(b.hotkey);
      if (key) set.add(key.toLowerCase());
    }
    return set;
  }, [boundWithKeys]);

  const keyOwner = useMemo(() => {
    const map = new Map<string, HotkeyBinding>();
    for (const b of boundWithKeys) {
      const { key } = parseHotkey(b.hotkey);
      if (key) map.set(key.toLowerCase(), b);
    }
    return map;
  }, [boundWithKeys]);

  const draftCombo = useMemo(() => {
    const parts: string[] = [];
    if (mods.ctrl) parts.push("Ctrl");
    if (mods.alt) parts.push("Alt");
    if (mods.shift) parts.push("Shift");
    parts.push("…");
    return parts.join("+");
  }, [mods]);

  const press = (token: string, asMod?: keyof ModState) => {
    if (asMod) {
      setMods((prev) => ({ ...prev, [asMod]: !prev[asMod] }));
      return;
    }
    const existing = keyOwner.get(token.toLowerCase());
    if (existing && !capturing) {
      onSelect(existing.id);
      return;
    }
    if (!selectedId) {
      if (existing) onSelect(existing.id);
      return;
    }
    if (!capturing) onStartCapture(selectedId);
    const hk = buildHotkey(mods, token);
    if (hk) onVirtualCommit(hk);
  };

  const lit = (token: string) => keyMatches(highlightHk, token);
  const bound = (token: string) => boundPrimaryKeys.has(token.toLowerCase());
  const tip = (token: string) => {
    const b = keyOwner.get(token.toLowerCase());
    return b ? `${b.label} · ${b.hotkey}` : undefined;
  };

  return (
    <div className="sfx-hotkeys">
      <div className="sfx-hotkeys-body stack">
        <div className="sfx-hotkeys-board">
          <div className="sfx-vk-mods" role="group" aria-label="modifiers">
            {(
              [
                ["ctrl", "Ctrl", mods.ctrl],
                ["alt", "Alt", mods.alt],
                ["shift", "Shift", mods.shift],
              ] as const
            ).map(([id, label, on]) => (
              <button
                key={id}
                type="button"
                className={on ? "sfx-vk-mod on" : "sfx-vk-mod"}
                onClick={() => setMods((prev) => ({ ...prev, [id]: !prev[id] }))}
              >
                {label}
              </button>
            ))}
            <span className="sfx-vk-mod-preview muted">
              {capturing ? `${t("sfxHotkeysDraft")} ${draftCombo}` : t("sfxHotkeysModHint")}
            </span>
          </div>

          <div
            className={capturing ? "sfx-vk capturing" : "sfx-vk"}
            aria-label={t("sfxTabMine")}
          >
            <div className="sfx-vk-row">
              {["esc", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"].map(
                (k) => (
                  <KeyCap
                    key={k}
                    label={k}
                    className="function"
                    lit={lit(k === "esc" ? "Escape" : k)}
                    bound={bound(k === "esc" ? "Escape" : k)}
                    title={tip(k === "esc" ? "Escape" : k)}
                    onClick={() => {
                      if (k === "esc") return;
                      press(k);
                    }}
                  />
                ),
              )}
            </div>

            <div className="sfx-vk-row">
              {["`", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="].map((k) => (
                <KeyCap
                  key={k}
                  label={k}
                  lit={lit(k)}
                  bound={bound(k)}
                  title={tip(k)}
                  onClick={() => press(k.length === 1 ? k.toUpperCase() : k)}
                />
              ))}
              <KeyCap
                label="del"
                className="delete"
                lit={lit("Delete")}
                bound={bound("Delete")}
                title={tip("Delete")}
                onClick={() => press("Delete")}
              />
            </div>

            <div className="sfx-vk-row">
              <KeyCap label="tab" className="tab" />
              {["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P", "[", "]"].map((k) => (
                <KeyCap
                  key={k}
                  label={k}
                  lit={lit(k)}
                  bound={bound(k)}
                  title={tip(k)}
                  onClick={() => press(k)}
                />
              ))}
              <KeyCap
                label="\\"
                className="backslash"
                lit={lit("\\")}
                bound={bound("\\")}
                title={tip("\\")}
                onClick={() => press("\\")}
              />
            </div>

            <div className="sfx-vk-row">
              <KeyCap label="caps" className="caps" />
              {["A", "S", "D", "F", "G", "H", "J", "K", "L", ";", "'"].map((k) => (
                <KeyCap
                  key={k}
                  label={k}
                  lit={lit(k)}
                  bound={bound(k)}
                  title={tip(k)}
                  onClick={() => press(k)}
                />
              ))}
              <KeyCap
                label="enter"
                className="return"
                lit={lit("Enter")}
                bound={bound("Enter")}
                title={tip("Enter")}
                onClick={() => press("Enter")}
              />
            </div>

            <div className="sfx-vk-row">
              <KeyCap
                label="shift"
                className="shift"
                lit={lit("Shift") || mods.shift}
                active={mods.shift}
                onClick={() => press("Shift", "shift")}
              />
              {["Z", "X", "C", "V", "B", "N", "M", ",", ".", "/"].map((k) => (
                <KeyCap
                  key={k}
                  label={k}
                  lit={lit(k)}
                  bound={bound(k)}
                  title={tip(k)}
                  onClick={() => press(k)}
                />
              ))}
              <KeyCap
                label="shift"
                className="shift"
                lit={lit("Shift") || mods.shift}
                active={mods.shift}
                onClick={() => press("Shift", "shift")}
              />
            </div>

            <div className="sfx-vk-row">
              <KeyCap label="fn" />
              <KeyCap
                label="ctrl"
                lit={lit("Ctrl") || mods.ctrl}
                active={mods.ctrl}
                onClick={() => press("Ctrl", "ctrl")}
              />
              <KeyCap
                label="alt"
                lit={lit("Alt") || mods.alt}
                active={mods.alt}
                onClick={() => press("Alt", "alt")}
              />
              <KeyCap label="win" />
              <KeyCap
                label=""
                className="space"
                lit={lit("Space")}
                bound={bound("Space")}
                title={tip("Space")}
                onClick={() => press("Space")}
              />
              <KeyCap label="win" />
              <KeyCap
                label="alt"
                lit={lit("Alt") || mods.alt}
                active={mods.alt}
                onClick={() => press("Alt", "alt")}
              />
              <KeyCap
                label="◀"
                className="arrow"
                lit={lit("Left")}
                bound={bound("Left")}
                title={tip("Left")}
                onClick={() => press("Left")}
              />
              <KeyCap
                label="▼"
                className="arrow"
                lit={lit("Down")}
                bound={bound("Down")}
                title={tip("Down")}
                onClick={() => press("Down")}
              />
              <KeyCap
                label="▲"
                className="arrow"
                lit={lit("Up")}
                bound={bound("Up")}
                title={tip("Up")}
                onClick={() => press("Up")}
              />
              <KeyCap
                label="▶"
                className="arrow"
                lit={lit("Right")}
                bound={bound("Right")}
                title={tip("Right")}
                onClick={() => press("Right")}
              />
            </div>
          </div>

          <div className={capturing ? "sfx-vk-legend capturing" : "sfx-vk-legend muted"}>
            {capturing
              ? t("sfxHotkeysVirtualHint")
              : selected
                ? `${selected.label} · ${selected.hotkey || t("sfxHotkeysUnset")}`
                : t("sfxHotkeysSelectFirst")}
          </div>
        </div>

        <section className="sfx-hotkeys-list">
          <div className="sfx-hotkeys-list-bar">
            <div className="sfx-hotkeys-list-head">
              {t("sfxHotkeysBindings")}
              <span className="sfx-hk-count">{sfxCount}</span>
            </div>
            <label className="sfx-hk-search">
              <Search size={13} strokeWidth={1.75} absoluteStrokeWidth />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("sfxHotkeysSearch")}
              />
            </label>
          </div>

          {filtered.length === 0 ? (
            <div className="sfx-hk-empty muted">
              {sfxCount === 0 ? t("sfxMineEmpty") : t("sfxNoMatch")}
            </div>
          ) : (
            <div className="sfx-hk-rows">
              {filtered.map((b, i) => {
                const isPlaying = Boolean(playing[b.id]);
                return (
                  <div
                    key={b.id}
                    className={[
                      "sfx-hk-row",
                      selectedId === b.id ? "on" : "",
                      isPlaying ? "playing" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      onSelect(b.id);
                      onTogglePlay(b.id);
                    }}
                    onDoubleClick={() => onStartCapture(b.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(b.id);
                        onTogglePlay(b.id);
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="sfx-hk-play"
                      title={isPlaying ? t("sfxStudioPause") : t("sfxPlayOnce")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onTogglePlay(b.id);
                      }}
                    >
                      <span className="sfx-hk-play-num">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {isPlaying ? (
                        <Pause
                          className="sfx-hk-play-icon"
                          size={14}
                          strokeWidth={0}
                          absoluteStrokeWidth
                          fill="currentColor"
                        />
                      ) : (
                        <Play
                          className="sfx-hk-play-icon"
                          size={14}
                          strokeWidth={0}
                          absoluteStrokeWidth
                          fill="currentColor"
                          style={{ marginLeft: 1 }}
                        />
                      )}
                    </button>
                    <span className="sfx-hk-row-kind">{t("sfxHotkeysKindSfx")}</span>
                    <span className="sfx-hk-row-label">{b.label}</span>
                    <span className={b.hotkey ? "sfx-hk-row-key" : "sfx-hk-row-key empty"}>
                      {selectedId === b.id && capturing
                        ? "…"
                        : b.hotkey || t("sfxHotkeysUnset")}
                    </span>
                    <button
                      type="button"
                      className="sfx-hk-row-act"
                      title={t("sfxSetHotkey")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartCapture(b.id);
                      }}
                    >
                      <Pencil size={13} strokeWidth={1.75} absoluteStrokeWidth />
                      <span>{t("sfxHotkeysEdit")}</span>
                    </button>
                    <button
                      type="button"
                      className="sfx-hk-row-act danger"
                      title={t("sfxRemoveFromMine")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onClear(b.id);
                      }}
                    >
                      <Trash2 size={13} strokeWidth={1.75} absoluteStrokeWidth />
                      <span>{t("sfxHotkeysRemove")}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <button
            type="button"
            className={capturing ? "sfx-hk-capture on" : "sfx-hk-capture"}
            disabled={!selectedId}
            onClick={() => {
              if (selectedId) onStartCapture(selectedId);
            }}
          >
            <Keyboard size={15} strokeWidth={1.75} absoluteStrokeWidth />
            <span>{capturing ? t("sfxCaptureHint") : t("sfxSetHotkey")}</span>
          </button>
        </section>
      </div>
    </div>
  );
}
