/**
 * baz-for-claude editor — Phase 1 (lite).
 *
 * Full-composition playback: every scene compiles into ONE Remotion module
 * (tracks honored, per-scene error boundaries), so play shows the whole video.
 * Edits recompile in place and the playhead is preserved — drag an element,
 * hit space, watch the full video from where you were.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Player, type PlayerRef } from '@remotion/player';
import { installGlobals } from './globals';
import { compileComposition, type CompScene } from './compile';
import { applyTranslate } from './patch';

installGlobals();

const FPS = 30; // platform-wide constant; no per-project fps exists

interface SceneInfo {
  id: string;
  name: string;
  track: number;
  order: number;
  startFrame: number;
  durationFrames: number;
  hasCode: boolean;
  tsxCode?: string;
}

interface ProjectSnapshot {
  project: { id: string; title: string; format: string; width: number; height: number };
  scenes: SceneInfo[];
}

interface Picked {
  loc: string; // "sceneId:line:col"
  sceneId: string;
  el: HTMLElement;
  tagName: string;
}

/**
 * Selection is a CHAIN, not a single element: the tagged ancestors of the hit
 * element, deepest first. The JSX tree is the grouping model — selecting a
 * parent and dragging moves its whole subtree (the "group"); selecting a
 * child moves it independently. Click the same spot again to widen selection
 * one level; the breadcrumb in the bar jumps to any level directly.
 */
interface Selection {
  chain: Picked[];
  index: number;
}

/**
 * Track-0 starts are DERIVED (cumulative by order), never read from the
 * snapshot — `props.start` goes stale for track 0 and every real renderer
 * ignores it. Track ≥1 uses the explicit stored start.
 */
function computeStarts(scenes: SceneInfo[]): Map<string, number> {
  const starts = new Map<string, number>();
  const track0 = scenes
    .filter((s) => s.track === 0)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  let acc = 0;
  for (const s of track0) {
    starts.set(s.id, acc);
    acc += s.durationFrames || 150;
  }
  for (const s of scenes) {
    if (s.track !== 0) starts.set(s.id, s.startFrame || 0);
  }
  return starts;
}

function timecode(frame: number): string {
  const sec = frame / FPS;
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, '0')}:${(sec - m * 60).toFixed(2).padStart(5, '0')}`;
}

interface Timing { start?: number; track?: number; duration?: number }

/**
 * Undo is a ledger of committed edits, each with enough to run its inverse
 * through the SAME write paths (set-code / positions / reorder). Cmd+Z pops
 * one; Cmd+Shift+Z replays it.
 */
type UndoEntry =
  | { kind: 'code'; sceneId: string; before: string; after: string }
  | { kind: 'timing'; updates: Array<{ sceneId: string; before: Timing; after: Timing }> }
  | { kind: 'reorder'; before: string[]; after: string[] };

function App() {
  const [snap, setSnap] = useState<ProjectSnapshot | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tsxById, setTsxById] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [status, setStatus] = useState('');
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<PlayerRef>(null);
  const selectionRef = useRef<Selection | null>(null);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  const undoRef = useRef<UndoEntry[]>([]);
  const redoRef = useRef<UndoEntry[]>([]);
  const [historyLens, setHistoryLens] = useState({ undo: 0, redo: 0 });
  const syncHistory = () => setHistoryLens({ undo: undoRef.current.length, redo: redoRef.current.length });
  const lastFrameRef = useRef(0);
  const wasPlayingRef = useRef(false);
  const dragRef = useRef<{
    sel: Picked;
    scale: number;
    samePlace: boolean;
    startX: number;
    startY: number;
    origTransform: string;
    moved: boolean;
  } | null>(null);

  // ---- load project ---------------------------------------------------------
  useEffect(() => {
    fetch('/api/editor/project')
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setSnap(d);
        const code: Record<string, string> = {};
        for (const s of d.scenes) if (s.tsxCode) code[s.id] = s.tsxCode;
        setTsxById(code);
      })
      .catch((e) => setLoadErr(e.message));
  }, []);

  // ---- composition ----------------------------------------------------------
  const starts = useMemo(() => (snap ? computeStarts(snap.scenes) : new Map()), [snap]);

  const totalFrames = useMemo(() => {
    if (!snap) return 1;
    let max = 0;
    for (const s of snap.scenes) {
      max = Math.max(max, (starts.get(s.id) ?? 0) + (s.durationFrames || 150));
    }
    return Math.max(1, max);
  }, [snap, starts]);

  const compiled = useMemo(() => {
    if (!snap) return null;
    const compScenes: CompScene[] = snap.scenes
      .filter((s) => tsxById[s.id])
      .map((s) => ({
        id: s.id,
        tsx: tsxById[s.id],
        start: starts.get(s.id) ?? 0,
        duration: s.durationFrames || 150,
        track: s.track,
      }));
    if (!compScenes.length) return null;
    return compileComposition(compScenes);
  }, [snap, tsxById, starts]);

  const lazyComponent = useMemo(() => {
    if (!compiled || compiled.error) return null;
    const url = compiled.blobUrl;
    return () => import(/* @vite-ignore */ url).then((m) => ({ default: m.default }));
  }, [compiled]);

  // ---- playhead continuity across recompiles --------------------------------
  // The Player remounts on every recompile (new module = new key). Track frame
  // and play-state continuously; after a remount, put both back — this is what
  // makes "drag, then press play" feel continuous instead of resetting.
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => {
      lastFrameRef.current = e.detail.frame;
      setFrame(e.detail.frame);
    };
    const onPlay = () => { wasPlayingRef.current = true; setPlaying(true); };
    const onPause = () => { wasPlayingRef.current = false; setPlaying(false); };
    p.addEventListener('frameupdate', onFrame as never);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    return () => {
      p.removeEventListener('frameupdate', onFrame as never);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
    };
  }, [compiled]);

  useEffect(() => {
    // After a remount: restore position (and motion) from before the swap.
    const p = playerRef.current;
    if (!p) return;
    const f = Math.min(lastFrameRef.current, totalFrames - 1);
    p.seekTo(f);
    if (wasPlayingRef.current) p.play();
    // The DOM was rebuilt — any selected element reference is dead.
    setSelection(null);
  }, [compiled, totalFrames]);

  // ---- write paths (shared by direct edits and undo/redo) -------------------
  const commitCode = useCallback(async (sceneId: string, code: string): Promise<string | null> => {
    const r = await fetch('/api/editor/scene-code', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneId, code }),
    });
    const res = await r.json();
    if (!r.ok) return res.error || 'save failed';
    if (res.compilationError) return String(res.compilationError);
    return null;
  }, []);

  const commitPositions = useCallback(async (updates: Array<{ sceneId: string } & Timing & { autoPlace?: boolean }>) => {
    // Track 0 derives start from order — sending one only pollutes props.start
    // with a value every renderer ignores. Strip it; round the rest to frames.
    const clean = updates.map((u) => {
      const c: Record<string, unknown> = { sceneId: u.sceneId };
      if (u.start !== undefined && u.track !== 0) c.start = Math.round(u.start);
      if (u.track !== undefined) c.track = u.track;
      if (u.duration !== undefined) c.duration = Math.round(u.duration);
      if (u.autoPlace) c.autoPlace = true;
      return c;
    });
    const r = await fetch('/api/editor/positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: clean }),
    });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || 'positions failed');
    return res;
  }, []);

  const commitReorder = useCallback(async (sceneIds: string[]) => {
    const r = await fetch('/api/editor/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneIds }),
    });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || 'reorder failed');
    return res;
  }, []);

  const applyLocalTiming = useCallback((updates: Array<{ sceneId: string } & Timing>) => {
    setSnap((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        scenes: prev.scenes.map((s) => {
          const u = updates.find((x) => x.sceneId === s.id);
          if (!u) return s;
          return {
            ...s,
            startFrame: u.start ?? s.startFrame,
            track: u.track ?? s.track,
            durationFrames: u.duration ?? s.durationFrames,
          };
        }),
      };
    });
  }, []);

  const applyLocalOrder = useCallback((sceneIds: string[]) => {
    setSnap((prev) => {
      if (!prev) return prev;
      const pos = new Map(sceneIds.map((id, i) => [id, i]));
      return {
        ...prev,
        scenes: prev.scenes.map((s) => (pos.has(s.id) ? { ...s, order: pos.get(s.id)! } : s)),
      };
    });
  }, []);

  /** Run one ledger entry in the given direction through the real write paths. */
  const applyEntry = useCallback(
    async (e: UndoEntry, dir: 'undo' | 'redo') => {
      if (e.kind === 'code') {
        const code = dir === 'undo' ? e.before : e.after;
        const err = await commitCode(e.sceneId, code);
        if (err) throw new Error(err);
        setTsxById((m) => ({ ...m, [e.sceneId]: code }));
      } else if (e.kind === 'timing') {
        const updates = e.updates.map((u) => ({ sceneId: u.sceneId, ...(dir === 'undo' ? u.before : u.after) }));
        await commitPositions(updates);
        applyLocalTiming(updates);
      } else {
        const ids = dir === 'undo' ? e.before : e.after;
        await commitReorder(ids);
        applyLocalOrder(ids);
      }
    },
    [commitCode, commitPositions, applyLocalTiming, applyLocalOrder, commitReorder]
  );

  const busyRef = useRef(false);
  const undo = useCallback(async () => {
    if (busyRef.current) return;
    const e = undoRef.current[undoRef.current.length - 1];
    if (!e) { setStatus('nothing to undo'); return; }
    busyRef.current = true;
    try {
      await applyEntry(e, 'undo');
      undoRef.current.pop();
      redoRef.current.push(e);
      setStatus(`↩ undid ${e.kind === 'code' ? 'element edit' : e.kind}`);
    } catch (err) {
      setStatus(`✗ undo failed: ${(err as Error).message}`);
    } finally {
      busyRef.current = false;
      syncHistory();
    }
  }, [applyEntry]);

  const redo = useCallback(async () => {
    if (busyRef.current) return;
    const e = redoRef.current[redoRef.current.length - 1];
    if (!e) { setStatus('nothing to redo'); return; }
    busyRef.current = true;
    try {
      await applyEntry(e, 'redo');
      redoRef.current.pop();
      undoRef.current.push(e);
      setStatus(`↪ redid ${e.kind === 'code' ? 'element edit' : e.kind}`);
    } catch (err) {
      setStatus(`✗ redo failed: ${(err as Error).message}`);
    } finally {
      busyRef.current = false;
      syncHistory();
    }
  }, [applyEntry]);

  const pushUndo = useCallback((e: UndoEntry) => {
    undoRef.current.push(e);
    redoRef.current = []; // a fresh edit invalidates the redo branch
    syncHistory();
  }, []);

  // ---- transport ------------------------------------------------------------
  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    else p.play();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^(INPUT|TEXTAREA)$/.test((document.activeElement as HTMLElement)?.tagName || '')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) void redo(); else void undo();
        return;
      }
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); playerRef.current?.seekTo(lastFrameRef.current + (e.shiftKey ? 10 : 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); playerRef.current?.seekTo(Math.max(0, lastFrameRef.current - (e.shiftKey ? 10 : 1))); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, undo, redo]);

  // ---- timeline commits -----------------------------------------------------
  const onTimelineCommit = useCallback(
    async (a: TimelineAction) => {
      if (a.type === 'reorder') {
        applyLocalOrder(a.order);
        setStatus('reordering…');
        try {
          await commitReorder(a.order);
          pushUndo({ kind: 'reorder', before: a.prev, after: a.order });
          setStatus('✓ reordered — ⌘Z to undo');
        } catch (err) {
          applyLocalOrder(a.prev);
          setStatus(`✗ reorder failed, reverted: ${(err as Error).message}`);
        }
        return;
      }

      const after: Timing =
        a.type === 'retime'
          ? { ...(a.start !== undefined ? { start: a.start } : {}), ...(a.track !== undefined ? { track: a.track } : {}) }
          : { ...(a.start !== undefined ? { start: a.start } : {}), duration: a.duration };
      const update = { sceneId: a.sceneId, ...after, ...(a.type === 'retime' && a.track !== undefined ? { autoPlace: true } : {}) };

      applyLocalTiming([update]);
      setStatus('saving timing…');
      try {
        const res = await commitPositions([update]);
        // The server may auto-place onto a different track — its truth wins.
        const resolved = Array.isArray(res.resolved) ? res.resolved[0] : null;
        if (resolved && resolved.finalTrack !== undefined && resolved.finalTrack !== update.track && update.track !== undefined) {
          applyLocalTiming([{ sceneId: a.sceneId, track: resolved.finalTrack }]);
        }
        pushUndo({ kind: 'timing', updates: [{ sceneId: a.sceneId, before: a.prev, after }] });
        setStatus(`✓ timing saved — ⌘Z to undo`);
      } catch (err) {
        applyLocalTiming([{ sceneId: a.sceneId, ...a.prev }]);
        setStatus(`✗ timing failed, reverted: ${(err as Error).message}`);
      }
    },
    [applyLocalOrder, applyLocalTiming, commitPositions, commitReorder, pushUndo]
  );

  // ---- canvas hit-testing + drag -------------------------------------------
  const pickAt = useCallback((x: number, y: number): Picked[] => {
    // elementsFromPoint (plural): full-track overlays (the audio scene's
    // AbsoluteFill spans the whole video, above track 0) would swallow every
    // hit if we only looked at the topmost element. Walk the whole stack to
    // the first tagged element, then collect its ENTIRE tagged ancestor chain
    // — that chain is the group hierarchy straight from the JSX source.
    const stack = document.elementsFromPoint(x, y) as HTMLElement[];
    for (const raw of stack) {
      if (raw.closest('.hit-overlay')) continue; // ourselves
      let el: HTMLElement | null = raw;
      while (el && el !== stageRef.current) {
        if (el.getAttribute('data-baz')) {
          const chain: Picked[] = [];
          let cur: HTMLElement | null = el;
          while (cur && cur !== stageRef.current) {
            const loc = cur.getAttribute('data-baz');
            if (loc) chain.push({ loc, sceneId: loc.split(':')[0], el: cur, tagName: cur.tagName.toLowerCase() });
            cur = cur.parentElement;
          }
          return chain;
        }
        el = el.parentElement;
      }
    }
    return [];
  }, []);

  const compositionScale = useCallback((): number => {
    const stage = stageRef.current;
    if (!stage || !snap) return 1;
    return stage.getBoundingClientRect().width / snap.project.width;
  }, [snap]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const chain = pickAt(e.clientX, e.clientY);
      if (!chain.length) {
        setSelection(null);
        return;
      }
      // Figma-style: pressing on the already-selected spot KEEPS the current
      // level as the drag target (drag moves what's highlighted); widening
      // happens on pointerUP without movement. A setState updater can't drive
      // this — it runs at render time, after we've already chosen the drag
      // target — hence the ref mirror.
      const prev = selectionRef.current;
      const samePlace = prev && prev.chain[0]?.loc === chain[0].loc;
      const index = samePlace ? Math.min(prev.index, chain.length - 1) : 0;
      setSelection({ chain, index });
      const target = chain[index];

      playerRef.current?.pause(); // editing happens on a still frame
      // Screen px ≠ element px: the composition is scaled by the player, and
      // scenes often add their own scale() wrappers. Measuring rendered width
      // vs layout width folds ALL ancestor scaling into one factor — this is
      // what makes the element land exactly where you drop it.
      const rect = target.el.getBoundingClientRect();
      const layoutW = (target.el as HTMLElement).offsetWidth;
      const scale = layoutW > 0 && rect.width > 0 ? rect.width / layoutW : compositionScale();
      dragRef.current = {
        sel: target,
        scale,
        samePlace: !!samePlace,
        startX: e.clientX,
        startY: e.clientY,
        origTransform: target.el.style.transform || '',
        moved: false,
      };
      try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    },
    [pickAt, compositionScale]
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // Live preview in the element's LOCAL px (same space the patch uses), so
    // the element tracks the cursor exactly and stays put after the save.
    const dx = (e.clientX - d.startX) / d.scale;
    const dy = (e.clientY - d.startY) / d.scale;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    d.sel.el.style.transform = `translate(${dx}px, ${dy}px) ${d.origTransform}`.trim();
  }, []);

  const onPointerUp = useCallback(
    async (e: React.PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      if (!d.moved) {
        // Clean click on the already-selected spot → widen one level (wraps).
        if (d.samePlace) {
          const prev = selectionRef.current;
          if (prev) setSelection({ chain: prev.chain, index: (prev.index + 1) % prev.chain.length });
        }
        return;
      }

      // Same local-px conversion the live preview used — drop point == final.
      const dx = Math.round(((e.clientX - d.startX) / d.scale) * 10) / 10;
      const dy = Math.round(((e.clientY - d.startY) / d.scale) * 10) / 10;
      d.sel.el.style.transform = d.origTransform;

      const [locSceneId, lineS, colS] = d.sel.loc.split(':');
      const current = tsxById[locSceneId];
      if (!current) return;
      const patched = applyTranslate(current, Number(lineS), Number(colS), dx, dy);
      if (!patched) {
        setStatus(`⚠ couldn't patch <${d.sel.tagName}> mechanically — send as a note instead`);
        return;
      }

      setTsxById((m) => ({ ...m, [locSceneId]: patched }));
      setStatus(`saving <${d.sel.tagName}> translate(${dx}, ${dy})…`);
      const err = await commitCode(locSceneId, patched).catch((e2: Error) => e2.message);
      if (err) {
        setTsxById((m) => ({ ...m, [locSceneId]: current }));
        setStatus(`✗ reverted: ${String(err).slice(0, 110)}`);
        return;
      }
      pushUndo({ kind: 'code', sceneId: locSceneId, before: current, after: patched });
      setStatus(`✓ saved <${d.sel.tagName}> translate(${dx}px, ${dy}px) — ⌘Z to undo`);
    },
    [tsxById, compositionScale, commitCode, pushUndo]
  );

  // ---- render ---------------------------------------------------------------
  if (loadErr) return <div className="pad err">Failed to load project: {loadErr}</div>;
  if (!snap) return <div className="pad dim">Loading project…</div>;

  const W = snap.project.width || 1920;
  const H = snap.project.height || 1080;
  const active = selection ? selection.chain[selection.index] : null;
  const selectedScene = active ? snap.scenes.find((s) => s.id === active.sceneId) : null;

  return (
    <div className="app">
      <div className="side">
        <div className="brand">baz <span>editor</span></div>
        <div className="proj">{snap.project.title}</div>
        {snap.scenes.map((s) => (
          <button
            key={s.id}
            className={
              'scene' +
              (active?.sceneId === s.id ? ' on' : '') +
              (s.hasCode ? '' : ' nocode')
            }
            onClick={() => playerRef.current?.seekTo(starts.get(s.id) ?? 0)}
            title={`seek to ${timecode(starts.get(s.id) ?? 0)}`}
          >
            <i>t{s.track}</i> {s.name}
          </button>
        ))}
      </div>

      <div className="main">
        <div className="bar">
          {selection && active ? (
            <span className="crumbs">
              <b>{selectedScene?.name ?? active.sceneId.slice(0, 8)}</b>
              {/* outermost → deepest, so it reads like a path; the group you
                  drag is whichever crumb is lit */}
              {[...selection.chain].reverse().map((p, i) => {
                const idx = selection.chain.length - 1 - i;
                return (
                  <button
                    key={p.loc + i}
                    className={'crumb' + (idx === selection.index ? ' on' : '')}
                    onClick={() => setSelection({ chain: selection.chain, index: idx })}
                    title={`select this ${idx === 0 ? 'element' : 'group'} — drag moves it and everything inside`}
                  >
                    {p.tagName}
                  </button>
                );
              })}
              <i className="hint">click same spot again = select group</i>
            </span>
          ) : (
            <span className="sel">click an element to select · click again for its group · space to play</span>
          )}
          <span className="status">{status}</span>
        </div>

        <div className="stage" ref={stageRef}>
          {compiled?.error && <div className="pad err">Compile error: {compiled.error}</div>}
          {lazyComponent && (
            <Player
              key={compiled!.blobUrl}
              ref={playerRef}
              lazyComponent={lazyComponent as never}
              durationInFrames={totalFrames}
              compositionWidth={W}
              compositionHeight={H}
              fps={FPS}
              controls={false}
              loop
              style={{ width: '100%', height: '100%' }}
              acknowledgeRemotionLicense
            />
          )}
          <div
            className="hit-overlay"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
          {active && <SelectionBox target={active.el} stage={stageRef.current} />}
        </div>

        <div className="transport">
          <button className="play" onClick={togglePlay}>{playing ? '❚❚' : '▶'}</button>
          <button className="hbtn" disabled={!historyLens.undo} onClick={() => void undo()} title="Undo (⌘Z)">↩</button>
          <button className="hbtn" disabled={!historyLens.redo} onClick={() => void redo()} title="Redo (⇧⌘Z)">↪</button>
          <span className="spacer" />
          <span className="tc">{timecode(frame)}</span>
        </div>

        <Timeline
          scenes={snap.scenes}
          starts={starts}
          totalFrames={totalFrames}
          frame={frame}
          activeSceneId={active?.sceneId ?? null}
          onSeek={(f) => { playerRef.current?.pause(); playerRef.current?.seekTo(f); }}
          commit={onTimelineCommit}
        />
      </div>
    </div>
  );
}

type TimelineAction =
  | { type: 'retime'; sceneId: string; start?: number; track?: number; prev: Timing }
  | { type: 'resize'; sceneId: string; start?: number; duration: number; prev: Timing }
  | { type: 'reorder'; order: string[]; prev: string[] };

const ROW_H = 34;
const RULER_H = 20;
const SNAP = 10; // frames, mirrors the RVE timeline

/**
 * Tracks-as-rows timeline (the baz.studio panel shape): highest track on top,
 * track 0 at the bottom. Clips drag horizontally to retime, vertically to
 * change track, and resize at the edges for duration. Track 0's semantics are
 * the platform's: its horizontal order IS its timing, so a same-row drag on
 * track 0 commits a REORDER; explicit starts only exist on track ≥1, and
 * track-0 left edges can't be trimmed (start is derived).
 */
function Timeline(props: {
  scenes: SceneInfo[];
  starts: Map<string, number>;
  totalFrames: number;
  frame: number;
  activeSceneId: string | null;
  onSeek: (f: number) => void;
  commit: (a: TimelineAction) => void;
}) {
  const { scenes, starts, totalFrames, frame, activeSceneId, onSeek, commit } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [ghost, setGhost] = useState<({ sceneId: string } & Required<Pick<Timing, 'start' | 'track' | 'duration'>>) | null>(null);
  const dragRef = useRef<{
    sceneId: string;
    zone: 'move' | 'resize-l' | 'resize-r';
    startX: number;
    startY: number;
    orig: { start: number; track: number; duration: number };
    moved: boolean;
  } | null>(null);

  const tracksDesc = useMemo(
    () => [...new Set(scenes.map((s) => s.track))].sort((a, b) => b - a),
    [scenes]
  );

  const pxPerFrame = () => (wrapRef.current ? wrapRef.current.getBoundingClientRect().width / totalFrames : 1);

  const snapFrames = (value: number, self: string): number => {
    const candidates: number[] = [0];
    for (const s of scenes) {
      if (s.id === self) continue;
      const st = starts.get(s.id) ?? 0;
      candidates.push(st, st + (s.durationFrames || 150));
    }
    let best = value;
    let bestD = SNAP + 1;
    for (const c of candidates) {
      const d = Math.abs(c - value);
      if (d < bestD) { bestD = d; best = c; }
    }
    return bestD <= SNAP ? best : value;
  };

  const onDown = (e: React.PointerEvent) => {
    const wrap = wrapRef.current!;
    const clipEl = (e.target as HTMLElement).closest('[data-clip]') as HTMLElement | null;
    try { wrap.setPointerCapture(e.pointerId); } catch { /* synthetic */ }

    if (!clipEl) {
      // Ruler / empty space: scrub.
      const r = wrap.getBoundingClientRect();
      const seek = (x: number) => onSeek(Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * (totalFrames - 1)));
      seek(e.clientX);
      const move = (ev: PointerEvent) => seek(ev.clientX);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return;
    }

    const sceneId = clipEl.getAttribute('data-clip')!;
    const scene = scenes.find((s) => s.id === sceneId)!;
    const rect = clipEl.getBoundingClientRect();
    const zone: 'move' | 'resize-l' | 'resize-r' =
      e.clientX - rect.left <= 8 ? 'resize-l' : rect.right - e.clientX <= 8 ? 'resize-r' : 'move';
    dragRef.current = {
      sceneId,
      zone,
      startX: e.clientX,
      startY: e.clientY,
      orig: { start: starts.get(sceneId) ?? 0, track: scene.track, duration: scene.durationFrames || 150 },
      moved: false,
    };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dxF = Math.round((e.clientX - d.startX) / pxPerFrame());
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) > 3) d.moved = true;
    if (!d.moved) return;

    if (d.zone === 'move') {
      const wrap = wrapRef.current!.getBoundingClientRect();
      const row = Math.max(0, Math.min(tracksDesc.length - 1, Math.floor((e.clientY - wrap.top - RULER_H) / ROW_H)));
      setGhost({
        sceneId: d.sceneId,
        start: snapFrames(Math.max(0, d.orig.start + dxF), d.sceneId),
        track: tracksDesc[row],
        duration: d.orig.duration,
      });
    } else if (d.zone === 'resize-r') {
      const end = snapFrames(d.orig.start + Math.max(5, d.orig.duration + dxF), d.sceneId);
      setGhost({ sceneId: d.sceneId, start: d.orig.start, track: d.orig.track, duration: Math.max(5, end - d.orig.start) });
    } else {
      // left trim: start moves, end stays — meaningless on track 0 (derived start)
      if (d.orig.track === 0) return;
      const ns = snapFrames(Math.max(0, Math.min(d.orig.start + dxF, d.orig.start + d.orig.duration - 5)), d.sceneId);
      setGhost({ sceneId: d.sceneId, start: ns, track: d.orig.track, duration: d.orig.start + d.orig.duration - ns });
    }
  };

  const onUp = () => {
    const d = dragRef.current;
    const g = ghost;
    dragRef.current = null;
    setGhost(null);
    if (!d || !d.moved || !g) return;

    if (d.zone === 'move') {
      if (g.track === 0 && d.orig.track === 0) {
        // Same-row move on track 0 = reorder by dragged centre.
        const t0 = scenes.filter((s) => s.track === 0).sort((a, b) => (starts.get(a.id) ?? 0) - (starts.get(b.id) ?? 0));
        const others = t0.filter((s) => s.id !== d.sceneId);
        const centre = g.start + g.duration / 2;
        let idx = 0;
        for (const s of others) {
          const st = starts.get(s.id) ?? 0;
          if (centre > st + (s.durationFrames || 150) / 2) idx++;
        }
        const prevIds = [...t0.map((s) => s.id), ...scenes.filter((s) => s.track !== 0).map((s) => s.id)];
        const newT0 = [...others.slice(0, idx).map((s) => s.id), d.sceneId, ...others.slice(idx).map((s) => s.id)];
        const order = [...newT0, ...scenes.filter((s) => s.track !== 0).map((s) => s.id)];
        if (order.join() !== prevIds.join()) commit({ type: 'reorder', order, prev: prevIds });
        return;
      }
      commit({
        type: 'retime',
        sceneId: d.sceneId,
        // Track 0 derives start from order — never send one when landing there.
        ...(g.track === 0 ? {} : { start: g.start }),
        ...(g.track !== d.orig.track ? { track: g.track } : {}),
        prev: { start: d.orig.start, track: d.orig.track },
      });
      return;
    }

    commit({
      type: 'resize',
      sceneId: d.sceneId,
      duration: g.duration,
      ...(d.zone === 'resize-l' ? { start: g.start } : {}),
      prev: { start: d.orig.start, duration: d.orig.duration },
    });
  };

  return (
    <div
      ref={wrapRef}
      className="tl"
      style={{ height: RULER_H + tracksDesc.length * ROW_H }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      <div className="tl-ruler" />
      {tracksDesc.map((t, row) => (
        <div key={t} className="tl-row" style={{ top: RULER_H + row * ROW_H }}>
          <span className="tl-tracklabel">t{t}</span>
        </div>
      ))}
      {scenes.map((s) => {
        const g = ghost?.sceneId === s.id ? ghost : null;
        const start = g ? g.start : starts.get(s.id) ?? 0;
        const dur = g ? g.duration : s.durationFrames || 150;
        const track = g ? g.track : s.track;
        const row = tracksDesc.indexOf(track);
        if (row < 0) return null;
        return (
          <div
            key={s.id}
            data-clip={s.id}
            className={'tl-clip' + (s.id === activeSceneId ? ' on' : '') + (g ? ' ghosting' : '')}
            style={{
              left: `${(start / totalFrames) * 100}%`,
              width: `${(dur / totalFrames) * 100}%`,
              top: RULER_H + row * ROW_H + 3,
              height: ROW_H - 6,
            }}
            title={`${s.name} · ${timecode(start)} → ${timecode(start + dur)}${track === 0 ? ' · drag = reorder' : ''}`}
          >
            <i className="hL" />
            <span className="tl-label">{s.name}</span>
            <i className="hR" />
          </div>
        );
      })}
      <div className="tl-head" style={{ left: `${(frame / Math.max(1, totalFrames - 1)) * 100}%` }} />
    </div>
  );
}

/** Outline that follows the selected element's rect. */
function SelectionBox({ target, stage }: { target: HTMLElement; stage: HTMLDivElement | null }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (target.isConnected) setRect(target.getBoundingClientRect());
      else setRect(null);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [target]);
  if (!rect || !stage) return null;
  const s = stage.getBoundingClientRect();
  return (
    <div
      className="selbox"
      style={{ left: rect.left - s.left, top: rect.top - s.top, width: rect.width, height: rect.height }}
    />
  );
}

createRoot(document.getElementById('root')!).render(<App />);
