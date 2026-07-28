import { useEffect, useMemo, useState } from "react";
import { load } from "@tauri-apps/plugin-store";
import type { Note } from "../Notepad";
import SfxMenuSelect from "../SfxMenuSelect";
import LiveMiniPlayer from "./LiveMiniPlayer";
import LiveMonitor from "./LiveMonitor";
import type { LiveSession } from "./liveTypes";

type Props = {
  session: LiveSession | null;
  allSessions: LiveSession[];
  cueNoteId: string | null;
  onCueNoteId: (id: string | null) => void;
  onEndLive: () => void;
  labels: {
    live: string;
    idle: string;
    endLive: string;
    heatTitle: string;
    viewers: string;
    gifts: string;
    senders: string;
    followers: string;
    commenters: string;
    likes: string;
    shares: string;
    fansClub: string;
    convTitle: string;
    modeMinute: string;
    modeTotal: string;
    showMinute: string;
    enterMinute: string;
    stayMinute: string;
    showTotal: string;
    enterTotal: string;
    giftTotal: string;
    enterRate: string;
    stayRate: string;
    giftRate: string;
    vs7: string;
    musicTitle: string;
    cuePick: string;
    cueEmpty: string;
    cueNoNotes: string;
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

export default function LiveBoard({
  session,
  allSessions,
  cueNoteId,
  onCueNoteId,
  onEndLive,
  labels,
}: Props) {
  const [notes, setNotes] = useState<Note[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await load("notepad.json", { autoSave: true });
        const list = (await store.get<Note[]>("notes")) ?? [];
        if (!cancelled) setNotes(Array.isArray(list) ? list : []);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeNote = useMemo(() => {
    if (!notes.length) return null;
    if (cueNoteId) {
      const hit = notes.find((n) => n.id === cueNoteId);
      if (hit) return hit;
    }
    return notes[0] ?? null;
  }, [notes, cueNoteId]);

  useEffect(() => {
    if (cueNoteId || !notes[0]) return;
    onCueNoteId(notes[0].id);
  }, [cueNoteId, notes, onCueNoteId]);

  return (
    <div className="live-board">
      <div className="live-board-left">
        <section className="live-board-panel live-board-metrics">
          <LiveMonitor
            session={session}
            allSessions={allSessions}
            labels={{
              live: labels.live,
              idle: labels.idle,
              endLive: labels.endLive,
              heatTitle: labels.heatTitle,
              viewers: labels.viewers,
              gifts: labels.gifts,
              senders: labels.senders,
              followers: labels.followers,
              commenters: labels.commenters,
              likes: labels.likes,
              shares: labels.shares,
              fansClub: labels.fansClub,
              convTitle: labels.convTitle,
              modeMinute: labels.modeMinute,
              modeTotal: labels.modeTotal,
              showMinute: labels.showMinute,
              enterMinute: labels.enterMinute,
              stayMinute: labels.stayMinute,
              showTotal: labels.showTotal,
              enterTotal: labels.enterTotal,
              giftTotal: labels.giftTotal,
              enterRate: labels.enterRate,
              stayRate: labels.stayRate,
              giftRate: labels.giftRate,
              vs7: labels.vs7,
            }}
            onEnd={onEndLive}
          />
        </section>

        <LiveMiniPlayer
          labels={{
            musicTitle: labels.musicTitle,
            bgmIdle: labels.bgmIdle,
            prev: labels.prev,
            next: labels.next,
            loopOne: labels.loopOne,
            loopList: labels.loopList,
            playlist: labels.playlist,
            playlistTitle: labels.playlistTitle,
            noPlaylist: labels.noPlaylist,
          }}
        />
      </div>

      <section className="live-board-panel live-board-cue">
        {notes.length > 0 ? (
          <div className="live-board-cue-bar">
            <SfxMenuSelect
              title={labels.cuePick}
              value={activeNote?.id ?? notes[0]!.id}
              options={notes.map((n) => ({
                value: n.id,
                label: n.title?.trim() || labels.cueEmpty,
              }))}
              onChange={(id) => onCueNoteId(id || null)}
              lockValueWidth={false}
            />
          </div>
        ) : null}
        {activeNote ? (
          <div className="live-board-cue-body notepad-editor-wrap">
            <div
              className="tiptap notepad-body notepad-rich notepad-tiptap"
              dangerouslySetInnerHTML={{ __html: activeNote.body || "" }}
            />
          </div>
        ) : (
          <p className="muted live-board-cue-empty">{labels.cueNoNotes}</p>
        )}
      </section>
    </div>
  );
}
