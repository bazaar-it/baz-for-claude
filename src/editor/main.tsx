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
import { applyTranslate, applyTransform, applyTextEdit, applyTrimIn, getTrimIn } from './patch';

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
/**
 * Structural edits (split / duplicate / delete / paste / trim) are several
 * writes that must undo as ONE gesture — a batch entry replays its ops in
 * order, and their inverses in reverse. Re-creating a deleted scene mints a
 * NEW id; the op records it back into itself so a later redo targets the
 * scene that actually exists (`placeAfter` keeps track-0 position).
 */
type PrimOp =
  | { op: 'code'; sceneId: string; before: string; after: string }
  | { op: 'timing'; updates: Array<{ sceneId: string; before: Timing; after: Timing }> }
  | { op: 'reorder'; before: string[]; after: string[] }
  | {
      op: 'create';
      sceneId: string; // updated in place on every (re)create
      code: string;
      name: string;
      track: number;
      start: number;
      duration: number;
      placeAfter: string | null; // track 0: insert after this scene (null = front)
    }
  | {
      op: 'delete';
      sceneId: string;
      code: string;
      name: string;
      track: number;
      start: number;
      duration: number;
      placeAfter: string | null;
    };

type UndoEntry =
  | { kind: 'code'; sceneId: string; before: string; after: string }
  | { kind: 'timing'; updates: Array<{ sceneId: string; before: Timing; after: Timing }> }
  | { kind: 'reorder'; before: string[]; after: string[] }
  | { kind: 'batch'; label: string; ops: PrimOp[] };

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

  /** Frames already trimmed off each scene's start (drives left-edge un-trim range). */
  const trims = useMemo(() => {
    const m = new Map<string, number>();
    for (const [id, code] of Object.entries(tsxById)) m.set(id, getTrimIn(code));
    return m;
  }, [tsxById]);

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

  // ---- double-buffered players: recompiles swap with NO flash ---------------
  // A recompile mounts the new module as a hidden "back" player, seeks it to
  // the current frame, and only once it has actually presented a frame do we
  // promote it to front (same React key → no remount on promotion). The old
  // player stays visible the whole time — the swap is invisible.
  interface PB { id: number; lazy: () => Promise<{ default: unknown }> }
  const [players, setPlayers] = useState<{ front: PB | null; back: PB | null }>({ front: null, back: null });
  const pbIdRef = useRef(0);
  const backRef = useRef<PlayerRef>(null);

  useEffect(() => {
    if (!compiled || compiled.error) return;
    const url = compiled.blobUrl;
    const pb: PB = {
      id: ++pbIdRef.current,
      lazy: () => import(/* @vite-ignore */ url).then((m) => ({ default: m.default })),
    };
    setPlayers((prev) => (prev.front ? { front: prev.front, back: pb } : { front: pb, back: null }));
  }, [compiled]);

  useEffect(() => {
    if (!players.back) return;
    let done = false;
    const dbg = (m: string) => {
      const w = window as unknown as { __bazdbg?: string[] };
      w.__bazdbg = (w.__bazdbg || []).concat(`${Math.round(performance.now())} ${m}`);
    };
    dbg(`back mounted id=${players.back.id}`);
    const promote = (why: string) => {
      if (done) return;
      done = true;
      dbg(`promote via ${why}`);
      setSelection(null); // the old DOM is about to unmount
      setPlayers((prev) => (prev.back ? { front: prev.back, back: null } : prev));
    };
    // Promote one paint AFTER readiness: the hidden player gets a painted frame
    // at opacity 0 first, so the opacity flip lands on already-rendered pixels.
    // rAF starves in throttled/embedded panes — race it against a short timer
    // so readiness never waits on a paint tick that isn't coming. promote()'s
    // `done` guard makes the double fire harmless.
    const promoteNextPaint = (why: string) => {
      const fallback = setTimeout(() => promote(`${why}+timer`), 150);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); promote(why); }));
    };
    let tries = 0;
    let unlisten = () => {};
    const arm = () => {
      if (done) return;
      const p = backRef.current;
      if (!p) {
        if (++tries < 120) setTimeout(arm, 25);
        else dbg('backRef never bound');
        return;
      }
      dbg(`arm: seeking back player to ${lastFrameRef.current}`);
      p.seekTo(Math.min(lastFrameRef.current, totalFrames - 1));
      // A paused player seeked to its CURRENT frame emits no frameupdate —
      // listen for seeked too, and let the content poll below catch the rest.
      const onFrame = () => { unlisten(); dbg('signal frameupdate'); promoteNextPaint('frameupdate'); };
      const onSeek = () => { unlisten(); dbg('signal seeked'); promoteNextPaint('seeked'); };
      p.addEventListener('frameupdate', onFrame as never);
      p.addEventListener('seeked', onSeek as never);
      unlisten = () => {
        p.removeEventListener('frameupdate', onFrame as never);
        p.removeEventListener('seeked', onSeek as never);
      };
    };
    arm();
    // Readiness poll: the hidden player's scene content exists in the DOM.
    // Event-independent — works even if this Player build emits neither event.
    const poll = setInterval(() => {
      if (done) return;
      const hidden = [...(stageRef.current?.children || [])].find(
        (c): c is HTMLElement => c.tagName === 'DIV' && (c as HTMLElement).style.opacity === '0'
      );
      if (hidden && hidden.querySelector('[data-baz]')) {
        unlisten();
        clearInterval(poll);
        dbg('signal content-poll');
        promoteNextPaint('content-poll');
      }
    }, 80);
    const safety = setTimeout(() => promote('safety'), 900); // never deadlock on a silent player
    return () => { done = true; unlisten(); clearInterval(poll); clearTimeout(safety); };
  }, [players.back, totalFrames]);

  useEffect(() => {
    // UI listeners + playback continuity live on whichever player is front.
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
    if (wasPlayingRef.current && !p.isPlaying()) p.play();
    return () => {
      p.removeEventListener('frameupdate', onFrame as never);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
    };
  }, [players.front]);

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

  const snapRef = useRef<ProjectSnapshot | null>(null);
  useEffect(() => { snapRef.current = snap; }, [snap]);

  /** Re-pull the whole project — the truth source after structural edits. */
  const refreshSnap = useCallback(async () => {
    const d = await (await fetch('/api/editor/project')).json();
    if (d.error) throw new Error(d.error);
    setSnap(d);
    const code: Record<string, string> = {};
    for (const s of d.scenes as SceneInfo[]) if (s.tsxCode) code[s.id] = s.tsxCode;
    setTsxById(code);
    return d as ProjectSnapshot;
  }, []);

  const createSceneApi = useCallback(
    async (p: { code: string; name: string; duration: number; track: number; start: number }) => {
      const r = await fetch('/api/editor/scene-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || 'create failed');
      return res.scene as SceneInfo;
    },
    []
  );

  const deleteSceneApi = useCallback(async (sceneId: string) => {
    const r = await fetch('/api/editor/scene-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sceneId }),
    });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || 'delete failed');
  }, []);

  /** Full playback-order id list with track-0 reordered to place `id` after `placeAfter`. */
  const orderWithPlacement = useCallback((scenes: SceneInfo[], id: string, placeAfter: string | null): string[] => {
    const t0 = scenes
      .filter((s) => s.track === 0 && s.id !== id)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((s) => s.id);
    const at = placeAfter ? t0.indexOf(placeAfter) + 1 : 0;
    t0.splice(at < 0 ? t0.length : at, 0, id);
    return [...t0, ...scenes.filter((s) => s.track !== 0 && s.id !== id).map((s) => s.id)];
  }, []);

  /**
   * Create a scene and land it EXACTLY where asked. `scenes create` treats
   * track+start as a literal rectangle and auto-places to a free track on
   * overlap (a track-0 create at start 0 ends up on track 2) — so for track 0
   * the create is followed by an explicit positions write pinning the track,
   * then a reorder placing it in the row.
   */
  const createPlaced = useCallback(
    async (
      p: { code: string; name: string; duration: number; track: number; start: number },
      placeAfter: string | null
    ): Promise<SceneInfo> => {
      const made = await createSceneApi(p);
      if (p.track === 0) {
        await commitPositions([{ sceneId: made.id, track: 0 }]);
        const cur = await refreshSnap();
        await commitReorder(orderWithPlacement(cur.scenes, made.id, placeAfter));
      }
      return made;
    },
    [createSceneApi, commitPositions, commitReorder, refreshSnap, orderWithPlacement]
  );

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

  /**
   * Undoing a delete (or redoing a create) re-creates the scene under a FRESH
   * id — every other ledger entry still referencing the old id would hit
   * "Scene not found" on later undo/redo. Heal the whole ledger in place.
   */
  const remapSceneId = useCallback((from: string, to: string) => {
    const swapIds = (ids: string[]) => ids.map((x) => (x === from ? to : x));
    const fixOp = (op: PrimOp) => {
      if (op.op === 'code' && op.sceneId === from) op.sceneId = to;
      else if (op.op === 'timing') op.updates.forEach((u) => { if (u.sceneId === from) u.sceneId = to; });
      else if (op.op === 'reorder') { op.before = swapIds(op.before); op.after = swapIds(op.after); }
      else if (op.op === 'create' || op.op === 'delete') {
        if (op.sceneId === from) op.sceneId = to;
        if (op.placeAfter === from) op.placeAfter = to;
      }
    };
    const fix = (e: UndoEntry) => {
      if (e.kind === 'code' && e.sceneId === from) e.sceneId = to;
      else if (e.kind === 'timing') e.updates.forEach((u) => { if (u.sceneId === from) u.sceneId = to; });
      else if (e.kind === 'reorder') { e.before = swapIds(e.before); e.after = swapIds(e.after); }
      else if (e.kind === 'batch') e.ops.forEach(fixOp);
    };
    undoRef.current.forEach(fix);
    redoRef.current.forEach(fix);
  }, []);

  /** Run one primitive op in the given direction through the real write paths. */
  const applyPrim = useCallback(
    async (op: PrimOp, dir: 'undo' | 'redo') => {
      if (op.op === 'code') {
        const code = dir === 'undo' ? op.before : op.after;
        const err = await commitCode(op.sceneId, code);
        if (err) throw new Error(err);
        setTsxById((m) => ({ ...m, [op.sceneId]: code }));
        return;
      }
      if (op.op === 'timing') {
        const updates = op.updates.map((u) => ({ sceneId: u.sceneId, ...(dir === 'undo' ? u.before : u.after) }));
        await commitPositions(updates);
        applyLocalTiming(updates);
        return;
      }
      if (op.op === 'reorder') {
        const ids = dir === 'undo' ? op.before : op.after;
        await commitReorder(ids);
        applyLocalOrder(ids);
        return;
      }
      // create / delete are inverses of each other; both end in a full
      // refresh because ids, orders and derived starts all shift.
      const bringBack = (op.op === 'create' && dir === 'redo') || (op.op === 'delete' && dir === 'undo');
      if (bringBack) {
        const made = await createPlaced(
          { code: op.code, name: op.name, duration: op.duration, track: op.track, start: op.start },
          op.placeAfter
        );
        remapSceneId(op.sceneId, made.id); // heal the whole ledger, this op included
      } else {
        await deleteSceneApi(op.sceneId);
      }
      await refreshSnap();
    },
    [commitCode, commitPositions, applyLocalTiming, applyLocalOrder, commitReorder, createPlaced, deleteSceneApi, refreshSnap, remapSceneId]
  );

  /** Run one ledger entry in the given direction. Batches run ops in order; undo runs their inverses in reverse. */
  const applyEntry = useCallback(
    async (e: UndoEntry, dir: 'undo' | 'redo') => {
      if (e.kind === 'batch') {
        const ops = dir === 'undo' ? [...e.ops].reverse() : e.ops;
        for (const op of ops) await applyPrim(op, dir);
        return;
      }
      if (e.kind === 'code') return applyPrim({ op: 'code', sceneId: e.sceneId, before: e.before, after: e.after }, dir);
      if (e.kind === 'timing') return applyPrim({ op: 'timing', updates: e.updates }, dir);
      return applyPrim({ op: 'reorder', before: e.before, after: e.after }, dir);
    },
    [applyPrim]
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
      setStatus(`↩ undid ${e.kind === 'code' ? 'element edit' : e.kind === 'batch' ? e.label : e.kind}`);
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
      setStatus(`↪ redid ${e.kind === 'code' ? 'element edit' : e.kind === 'batch' ? e.label : e.kind}`);
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

  // ---- structural ops (CapCut keyboard grammar) -----------------------------
  // ⌘D duplicate · ⌘B split at playhead · ⌫ delete · ⌘C/⌘V copy/paste.
  // All of them are batch ledger entries so one ⌘Z reverts the whole gesture.
  const [timelineSel, setTimelineSel] = useState<string | null>(null);
  const timelineSelRef = useRef<string | null>(null);
  useEffect(() => { timelineSelRef.current = timelineSel; }, [timelineSel]);
  const clipboardRef = useRef<{ code: string; name: string; duration: number; track: number } | null>(null);

  /** The scene keyboard ops act on: explicit timeline selection, else the canvas selection's scene. */
  const kbScene = useCallback((): SceneInfo | null => {
    const id = timelineSelRef.current ?? selectionRef.current?.chain[selectionRef.current.index]?.sceneId;
    return (id && snapRef.current?.scenes.find((s) => s.id === id)) || null;
  }, []);

  /** Track-0 neighbour to insert after, for placing a new scene next to `s`. */
  const t0PlaceAfter = useCallback((s: SceneInfo): string | null => (s.track === 0 ? s.id : null), []);

  const structuralBusy = useRef(false);
  const runStructural = useCallback(
    async (label: string, build: () => Promise<PrimOp[]>) => {
      if (structuralBusy.current) return;
      structuralBusy.current = true;
      setStatus(`${label}…`);
      try {
        const ops = await build();
        pushUndo({ kind: 'batch', label, ops });
        setStatus(`✓ ${label} — ⌘Z to undo`);
      } catch (err) {
        setStatus(`✗ ${label} failed: ${(err as Error).message}`);
        // state may be part-written — re-pull the truth
        refreshSnap().catch(() => {});
      } finally {
        structuralBusy.current = false;
      }
    },
    [pushUndo, refreshSnap]
  );

  const duplicateScene = useCallback(() => {
    const s = kbScene();
    if (!s) { setStatus('select a clip first'); return; }
    const code = tsxRef.current[s.id];
    if (!code) { setStatus('scene has no code to duplicate'); return; }
    void runStructural('duplicate', async () => {
      const dur = s.durationFrames || 150;
      const start = s.track === 0 ? 0 : (starts.get(s.id) ?? 0) + dur; // right after, same track
      const made = await createPlaced(
        { code, name: `${s.name} copy`, duration: dur, track: s.track, start },
        t0PlaceAfter(s)
      );
      await refreshSnap();
      setTimelineSel(made.id);
      return [{
        op: 'create', sceneId: made.id, code, name: `${s.name} copy`,
        track: s.track, start, duration: dur, placeAfter: t0PlaceAfter(s),
      }];
    });
  }, [kbScene, runStructural, createPlaced, refreshSnap, starts, t0PlaceAfter]);

  const splitScene = useCallback(() => {
    const s = kbScene();
    if (!s) { setStatus('select a clip first'); return; }
    const code = tsxRef.current[s.id];
    if (!code) { setStatus('scene has no code to split'); return; }
    const dur = s.durationFrames || 150;
    const sceneStart = starts.get(s.id) ?? 0;
    const t = Math.round(lastFrameRef.current - sceneStart);
    if (t < 5 || t > dur - 5) { setStatus('move the playhead inside the clip to split'); return; }
    const part2Code = applyTrimIn(code, getTrimIn(code) + t);
    if (!part2Code) { setStatus("⚠ can't split this scene — its component shape is too unusual"); return; }
    void runStructural('split', async () => {
      const part2Start = s.track === 0 ? 0 : sceneStart + t;
      const made = await createPlaced(
        { code: part2Code, name: s.name, duration: dur - t, track: s.track, start: part2Start },
        t0PlaceAfter(s)
      );
      await commitPositions([{ sceneId: s.id, duration: t, track: s.track }]);
      await refreshSnap();
      return [
        {
          op: 'create', sceneId: made.id, code: part2Code, name: s.name,
          track: s.track, start: part2Start, duration: dur - t, placeAfter: t0PlaceAfter(s),
        },
        { op: 'timing', updates: [{ sceneId: s.id, before: { duration: dur, track: s.track }, after: { duration: t, track: s.track } }] },
      ];
    });
  }, [kbScene, runStructural, createPlaced, refreshSnap, commitPositions, starts, t0PlaceAfter]);

  const deleteSelected = useCallback(() => {
    const s = kbScene();
    if (!s) { setStatus('select a clip first'); return; }
    const code = tsxRef.current[s.id] ?? '';
    // remember the track-0 neighbour BEFORE the delete, for undo placement
    const t0 = (snapRef.current?.scenes || [])
      .filter((x) => x.track === 0)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const idx = t0.findIndex((x) => x.id === s.id);
    const placeAfter = idx > 0 ? t0[idx - 1].id : null;
    void runStructural('delete', async () => {
      await deleteSceneApi(s.id);
      await refreshSnap();
      setTimelineSel(null);
      setSelection(null);
      return [{
        op: 'delete', sceneId: s.id, code, name: s.name,
        track: s.track, start: starts.get(s.id) ?? 0,
        duration: s.durationFrames || 150, placeAfter,
      }];
    });
  }, [kbScene, runStructural, deleteSceneApi, refreshSnap, starts]);

  const copySelected = useCallback(() => {
    const s = kbScene();
    if (!s) return;
    const code = tsxRef.current[s.id];
    if (!code) { setStatus('scene has no code to copy'); return; }
    clipboardRef.current = { code, name: s.name, duration: s.durationFrames || 150, track: s.track };
    setStatus(`copied ${s.name}`);
  }, [kbScene]);

  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip) { setStatus('nothing copied'); return; }
    void runStructural('paste', async () => {
      const here = Math.round(lastFrameRef.current);
      // track 0: insert at the playhead's slot; track ≥1: start at the playhead
      let placeAfter: string | null = null;
      if (clip.track === 0) {
        const t0 = (snapRef.current?.scenes || [])
          .filter((x) => x.track === 0)
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        for (const x of t0) {
          const st = starts.get(x.id) ?? 0;
          if (here > st + (x.durationFrames || 150) / 2) placeAfter = x.id;
        }
      }
      const made = await createPlaced(
        {
          code: clip.code, name: clip.name, duration: clip.duration,
          track: clip.track, start: clip.track === 0 ? 0 : here,
        },
        placeAfter
      );
      await refreshSnap();
      setTimelineSel(made.id);
      return [{
        op: 'create', sceneId: made.id, code: clip.code, name: clip.name,
        track: clip.track, start: clip.track === 0 ? 0 : here,
        duration: clip.duration, placeAfter,
      }];
    });
  }, [runStructural, createPlaced, refreshSnap, starts]);

  // ---- transport ------------------------------------------------------------
  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    else p.play();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement as HTMLElement | null;
      if (/^(INPUT|TEXTAREA)$/.test(ae?.tagName || '') || ae?.isContentEditable) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) void redo(); else void undo();
        return;
      }
      // CapCut grammar: ⌘B split · ⌘D duplicate · ⌘C/⌘V/⌘X clipboard · ⌫ delete
      if (mod && k === 'b') { e.preventDefault(); splitScene(); return; }
      if (mod && k === 'd') { e.preventDefault(); duplicateScene(); return; }
      if (mod && k === 'c') { copySelected(); return; }
      if (mod && k === 'v') { pasteClipboard(); return; }
      if (mod && k === 'x') { copySelected(); deleteSelected(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelected(); return; }
      if (e.key === 'Escape') { setTimelineSel(null); setSelection(null); return; }
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); playerRef.current?.seekTo(lastFrameRef.current + (e.shiftKey ? 10 : 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); playerRef.current?.seekTo(Math.max(0, lastFrameRef.current - (e.shiftKey ? 10 : 1))); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, undo, redo, splitScene, duplicateScene, copySelected, pasteClipboard, deleteSelected]);

  // ---- timeline commits -----------------------------------------------------
  const onTimelineCommit = useCallback(
    async (a: TimelineAction) => {
      if (a.type === 'trim') {
        const code = tsxRef.current[a.sceneId];
        if (!code) { setStatus('scene has no code to trim'); return; }
        const newTrim = getTrimIn(code) + a.delta;
        const newCode = applyTrimIn(code, newTrim);
        if (!newCode) { setStatus("⚠ can't trim this scene — its component shape is too unusual"); return; }
        const before: Timing = { duration: a.prevDuration, track: a.track, ...(a.track !== 0 ? { start: a.prevStart } : {}) };
        const after: Timing = { duration: a.prevDuration - a.delta, track: a.track, ...(a.track !== 0 ? { start: a.prevStart + a.delta } : {}) };
        setStatus('trimming…');
        try {
          const err = await commitCode(a.sceneId, newCode);
          if (err) throw new Error(err);
          setTsxById((m) => ({ ...m, [a.sceneId]: newCode }));
          await commitPositions([{ sceneId: a.sceneId, ...after }]);
          applyLocalTiming([{ sceneId: a.sceneId, ...after }]);
          pushUndo({
            kind: 'batch', label: 'trim', ops: [
              { op: 'code', sceneId: a.sceneId, before: code, after: newCode },
              { op: 'timing', updates: [{ sceneId: a.sceneId, before, after }] },
            ],
          });
          setStatus(`✓ trimmed ${Math.abs(a.delta)} frames ${a.delta > 0 ? 'off' : 'back onto'} the start — ⌘Z to undo`);
        } catch (err) {
          setStatus(`✗ trim failed: ${(err as Error).message}`);
          refreshSnap().catch(() => {});
        }
        return;
      }

      if (a.type === 'adopt0') {
        setStatus('moving to main track…');
        try {
          await commitPositions([{ sceneId: a.sceneId, track: 0 }]);
          await commitReorder(a.order);
          await refreshSnap();
          pushUndo({
            kind: 'batch', label: 'move to main track', ops: [
              { op: 'timing', updates: [{ sceneId: a.sceneId, before: a.prev, after: { track: 0 } }] },
              { op: 'reorder', before: a.prevOrder, after: a.order },
            ],
          });
          setStatus('✓ moved to main track — ⌘Z to undo');
        } catch (err) {
          setStatus(`✗ move failed: ${(err as Error).message}`);
          refreshSnap().catch(() => {});
        }
        return;
      }

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
    [applyLocalOrder, applyLocalTiming, commitPositions, commitReorder, pushUndo, commitCode, refreshSnap]
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

  // ---- inline text editing (double-click) -----------------------------------
  const [editingText, setEditingText] = useState<{ loc: string; el: HTMLElement; original: string } | null>(null);
  const editingRef = useRef<typeof editingText>(null);
  useEffect(() => { editingRef.current = editingText; }, [editingText]);
  const tsxRef = useRef(tsxById);
  useEffect(() => { tsxRef.current = tsxById; }, [tsxById]);

  const finishTextEdit = useCallback(
    async (commitIt: boolean) => {
      const ed = editingRef.current;
      if (!ed) return;
      const newText = ed.el.textContent ?? '';
      ed.el.removeAttribute('contenteditable');
      ed.el.classList.remove('baz-editing');
      setEditingText(null);
      if (!commitIt || newText === ed.original) {
        ed.el.textContent = ed.original;
        return;
      }
      const [sceneId, l, c] = ed.loc.split(':');
      const current = tsxRef.current[sceneId];
      const patched = current ? applyTextEdit(current, Number(l), Number(c), newText) : null;
      if (!patched) {
        ed.el.textContent = ed.original;
        setStatus('⚠ that text is generated by code — change it with a prompt instead');
        return;
      }
      setTsxById((m) => ({ ...m, [sceneId]: patched }));
      setStatus('saving text…');
      const err = await commitCode(sceneId, patched).catch((e: Error) => e.message);
      if (err) {
        setTsxById((m) => ({ ...m, [sceneId]: current }));
        setStatus(`✗ reverted: ${String(err).slice(0, 110)}`);
        return;
      }
      pushUndo({ kind: 'code', sceneId, before: current, after: patched });
      setStatus(`✓ text saved — ⌘Z to undo`);
    },
    [commitCode, pushUndo]
  );

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (editingRef.current) return;
      // Text sits under overlapping containers in collage scenes — scan the
      // whole hit stack for the first tagged element that is a TEXT LEAF,
      // instead of taking whichever container is topmost (pickAt's rule).
      const stack = document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[];
      let deep: Picked | null = null;
      for (const raw of stack) {
        if (raw.closest('.hit-overlay')) continue;
        let el2: HTMLElement | null = raw;
        while (el2 && el2 !== stageRef.current) {
          const loc = el2.getAttribute('data-baz');
          if (loc && el2.children.length === 0 && (el2.textContent || '').trim()) {
            deep = { loc, sceneId: loc.split(':')[0], el: el2, tagName: el2.tagName.toLowerCase() };
            break;
          }
          el2 = el2.parentElement;
        }
        if (deep) break;
      }
      // Whether the SOURCE is editable is decided by the patcher at commit.
      if (!deep) return;
      playerRef.current?.pause();
      setSelection(null);
      const el = deep.el;
      setEditingText({ loc: deep.loc, el, original: el.textContent || '' });
      el.setAttribute('contenteditable', 'plaintext-only');
      if (!el.isContentEditable) el.setAttribute('contenteditable', 'true'); // fallback
      el.classList.add('baz-editing');
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    },
    [pickAt]
  );

  useEffect(() => {
    if (!editingText) return;
    const el = editingText.el;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void finishTextEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); void finishTextEdit(false); }
      e.stopPropagation();
    };
    const onOutside = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) void finishTextEdit(true);
    };
    el.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside, true);
    return () => {
      el.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside, true);
    };
  }, [editingText, finishTextEdit]);

  // ---- corner-handle scaling ------------------------------------------------
  const commitScale = useCallback(
    async (factor: number) => {
      const act = selectionRef.current?.chain[selectionRef.current.index];
      if (!act) return;
      const [sceneId, l, c] = act.loc.split(':');
      const current = tsxRef.current[sceneId];
      const patched = current ? applyTransform(current, Number(l), Number(c), 0, 0, factor) : null;
      if (!patched) {
        setStatus(`⚠ couldn't scale <${act.tagName}> mechanically — send it as a note instead`);
        return;
      }
      setTsxById((m) => ({ ...m, [sceneId]: patched }));
      setStatus(`saving scale ×${factor.toFixed(2)}…`);
      const err = await commitCode(sceneId, patched).catch((e: Error) => e.message);
      if (err) {
        setTsxById((m) => ({ ...m, [sceneId]: current }));
        setStatus(`✗ reverted: ${String(err).slice(0, 110)}`);
        return;
      }
      pushUndo({ kind: 'code', sceneId, before: current, after: patched });
      setStatus(`✓ scaled <${act.tagName}> ×${factor.toFixed(2)} — ⌘Z to undo`);
    },
    [commitCode, pushUndo]
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
      <div className="main">
        <div className="bar">
          <span className="brandmini">baz</span>
          <span className="projmini">{snap.project.title}</span>
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
          {[players.front, players.back].filter(Boolean).map((pb) => {
            const isFront = pb!.id === players.front?.id;
            return (
              <Player
                key={pb!.id}
                ref={isFront ? playerRef : backRef}
                lazyComponent={pb!.lazy as never}
                durationInFrames={totalFrames}
                compositionWidth={W}
                compositionHeight={H}
                fps={FPS}
                controls={false}
                loop
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  opacity: isFront ? 1 : 0,
                  // ONLY the hidden back player is hit-test-invisible.
                  // pointer-events:none on the front one would make
                  // elementsFromPoint skip the whole composition subtree,
                  // killing selection, dragging and text editing at once.
                  // (The overlay above the player eats real clicks anyway.)
                  pointerEvents: isFront ? 'auto' : 'none',
                }}
                acknowledgeRemotionLicense
              />
            );
          })}
          <div
            className={'hit-overlay' + (editingText ? ' pass' : '')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick}
          />
          {active && !editingText && (
            <SelectionBox target={active.el} stage={stageRef.current} onScale={commitScale} />
          )}
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
          trims={trims}
          totalFrames={totalFrames}
          frame={frame}
          activeSceneId={timelineSel ?? active?.sceneId ?? null}
          onSeek={(f) => { playerRef.current?.pause(); playerRef.current?.seekTo(f); }}
          onSelect={setTimelineSel}
          commit={onTimelineCommit}
        />
      </div>
    </div>
  );
}

type TimelineAction =
  | { type: 'retime'; sceneId: string; start?: number; track?: number; prev: Timing }
  | { type: 'resize'; sceneId: string; start?: number; duration: number; prev: Timing }
  | { type: 'reorder'; order: string[]; prev: string[] }
  // left-edge drag: trim `delta` frames off the clip's CONTENT start (negative restores)
  | { type: 'trim'; sceneId: string; delta: number; prevStart: number; prevDuration: number; track: number }
  // a clip from track ≥1 dropped INTO track 0 at a specific slot
  | { type: 'adopt0'; sceneId: string; prev: Timing; order: string[]; prevOrder: string[] };

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
  trims: Map<string, number>;
  totalFrames: number;
  frame: number;
  activeSceneId: string | null;
  onSeek: (f: number) => void;
  onSelect: (id: string | null) => void;
  commit: (a: TimelineAction) => void;
}) {
  const { scenes, starts, trims, totalFrames, frame, activeSceneId, onSeek, onSelect, commit } = props;
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
      // Ruler / empty space: scrub. A press in the row area (not the ruler)
      // also drops the clip selection — CapCut's click-away behaviour.
      const r = wrap.getBoundingClientRect();
      if (e.clientY - r.top > RULER_H) onSelect(null);
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
    // Selected clips grow their trim zones — easy to grab, like CapCut.
    const edge = sceneId === activeSceneId ? 16 : 8;
    const zone: 'move' | 'resize-l' | 'resize-r' =
      e.clientX - rect.left <= edge ? 'resize-l' : rect.right - e.clientX <= edge ? 'resize-r' : 'move';
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
      // Left edge = TRIM-IN: cut content off the clip's start (the clip's end
      // stays put; on track 0 later clips ripple after commit). Dragging LEFT
      // restores previously trimmed frames — never past the original frame 0.
      const trimmed = trims.get(d.sceneId) ?? 0;
      const delta = Math.max(-trimmed, Math.min(dxF, d.orig.duration - 5));
      setGhost({ sceneId: d.sceneId, start: d.orig.start + delta, track: d.orig.track, duration: d.orig.duration - delta });
    }
  };

  const onUp = () => {
    const d = dragRef.current;
    const g = ghost;
    dragRef.current = null;
    setGhost(null);
    if (!d) return;
    if (!d.moved) {
      // Clean click: select the clip (grows its trim handles, arms ⌘D/⌘B/⌫).
      onSelect(d.sceneId);
      return;
    }
    if (!g) return;

    if (d.zone === 'move') {
      if (g.track === 0) {
        // Landing on track 0 — position in the row comes from the dragged
        // centre, ANY number of slots away. From another track it's an
        // adoption: track change + insertion in one undoable gesture.
        const t0 = scenes.filter((s) => s.track === 0).sort((a, b) => (starts.get(a.id) ?? 0) - (starts.get(b.id) ?? 0));
        const others = t0.filter((s) => s.id !== d.sceneId);
        const centre = g.start + g.duration / 2;
        let idx = 0;
        for (const s of others) {
          const st = starts.get(s.id) ?? 0;
          if (centre > st + (s.durationFrames || 150) / 2) idx++;
        }
        const rest = scenes.filter((s) => s.track !== 0 && s.id !== d.sceneId).map((s) => s.id);
        const newT0 = [...others.slice(0, idx).map((s) => s.id), d.sceneId, ...others.slice(idx).map((s) => s.id)];
        const order = [...newT0, ...rest];
        if (d.orig.track === 0) {
          const prevIds = [...t0.map((s) => s.id), ...rest];
          if (order.join() !== prevIds.join()) commit({ type: 'reorder', order, prev: prevIds });
        } else {
          const prevOrder = [...t0.map((s) => s.id), d.sceneId, ...rest];
          commit({
            type: 'adopt0',
            sceneId: d.sceneId,
            prev: { start: d.orig.start, track: d.orig.track },
            order,
            prevOrder,
          });
        }
        return;
      }
      commit({
        type: 'retime',
        sceneId: d.sceneId,
        start: g.start,
        ...(g.track !== d.orig.track ? { track: g.track } : {}),
        prev: { start: d.orig.start, track: d.orig.track },
      });
      return;
    }

    if (d.zone === 'resize-l') {
      const delta = g.start - d.orig.start; // >0 trims, <0 restores
      if (delta !== 0) {
        commit({
          type: 'trim',
          sceneId: d.sceneId,
          delta,
          prevStart: d.orig.start,
          prevDuration: d.orig.duration,
          track: d.orig.track,
        });
      }
      return;
    }

    commit({
      type: 'resize',
      sceneId: d.sceneId,
      duration: g.duration,
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
      {(() => {
        // While a track-0 clip is being dragged along its row, the OTHER
        // track-0 clips part around the would-be insertion point — the gap
        // opening up is the "you can drop here" feedback. CSS transitions on
        // left make them glide rather than jump.
        let preview: Map<string, number> | null = null;
        if (ghost) {
          // Any clip hovering the main track parts the row — including one
          // being dragged DOWN from an upper track.
          if (ghost.track === 0) {
            const others = scenes
              .filter((sc) => sc.track === 0 && sc.id !== ghost.sceneId)
              .sort((a, b) => (starts.get(a.id) ?? 0) - (starts.get(b.id) ?? 0));
            const centre = ghost.start + ghost.duration / 2;
            preview = new Map();
            let acc = 0;
            let inserted = false;
            for (const sc of others) {
              const dur = sc.durationFrames || 150;
              if (!inserted && centre <= acc + dur / 2) { acc += ghost.duration; inserted = true; }
              preview.set(sc.id, acc);
              acc += dur;
            }
          }
        }
        return scenes.map((s) => {
          const g = ghost?.sceneId === s.id ? ghost : null;
          const start = g ? g.start : preview?.get(s.id) ?? starts.get(s.id) ?? 0;
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
                left: `calc(${(start / totalFrames) * 100}% + 2px)`,
                width: `calc(${(dur / totalFrames) * 100}% - 4px)`,
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
        });
      })()}
      <div className="tl-head" style={{ left: `${(frame / Math.max(1, totalFrames - 1)) * 100}%` }} />
    </div>
  );
}

/** Outline + corner scale handles that follow the selected element's rect. */
function SelectionBox({ target, stage, onScale }: { target: HTMLElement; stage: HTMLDivElement | null; onScale: (f: number) => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const drag = useRef<{ ax: number; ay: number; d0: number; orig: string; f: number } | null>(null);
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

  const startScale = (e: React.PointerEvent, corner: string) => {
    e.stopPropagation();
    const r = target.getBoundingClientRect();
    // Anchor = the OPPOSITE corner; dragging changes the diagonal ratio.
    const ax = corner.includes('w') ? r.right : r.left;
    const ay = corner.includes('n') ? r.bottom : r.top;
    drag.current = { ax, ay, d0: Math.max(8, Math.hypot(e.clientX - ax, e.clientY - ay)), orig: target.style.transform || '', f: 1 };
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  };
  const moveScale = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.f = Math.max(0.05, Math.hypot(e.clientX - d.ax, e.clientY - d.ay) / d.d0);
    // Live preview only — the patch owns the real value after commit.
    target.style.transform = `${d.orig} scale(${d.f})`.trim();
  };
  const endScale = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    target.style.transform = d.orig;
    if (Math.abs(d.f - 1) > 0.01) onScale(Math.round(d.f * 1000) / 1000);
  };

  const corners: Array<[string, number, number, string]> = [
    ['nw', rect.left - s.left, rect.top - s.top, 'nwse-resize'],
    ['ne', rect.right - s.left, rect.top - s.top, 'nesw-resize'],
    ['sw', rect.left - s.left, rect.bottom - s.top, 'nesw-resize'],
    ['se', rect.right - s.left, rect.bottom - s.top, 'nwse-resize'],
  ];
  return (
    <>
      <div
        className="selbox"
        style={{ left: rect.left - s.left, top: rect.top - s.top, width: rect.width, height: rect.height }}
      />
      {corners.map(([c, x, y, cursor]) => (
        <div
          key={c}
          className="selhandle"
          style={{ left: x - 5, top: y - 5, cursor }}
          onPointerDown={(e) => startScale(e, c)}
          onPointerMove={moveScale}
          onPointerUp={endScale}
        />
      ))}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
