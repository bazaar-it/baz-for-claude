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
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); playerRef.current?.seekTo(lastFrameRef.current + (e.shiftKey ? 10 : 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); playerRef.current?.seekTo(Math.max(0, lastFrameRef.current - (e.shiftKey ? 10 : 1))); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay]);

  const seekFromStrip = useCallback(
    (clientX: number, strip: HTMLElement) => {
      const r = strip.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      playerRef.current?.seekTo(Math.round(pct * (totalFrames - 1)));
    },
    [totalFrames]
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
      try {
        const r = await fetch('/api/editor/scene-code', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneId: locSceneId, code: patched }),
        });
        const res = await r.json();
        if (!r.ok) throw new Error(res.error || 'save failed');
        if (res.compilationError) {
          setTsxById((m) => ({ ...m, [locSceneId]: current }));
          setStatus(`✗ server compile error, reverted: ${String(res.compilationError).slice(0, 110)}`);
          return;
        }
        setStatus(`✓ saved <${d.sel.tagName}> translate(${dx}px, ${dy}px)`);
      } catch (err) {
        setTsxById((m) => ({ ...m, [locSceneId]: current }));
        setStatus(`✗ save failed, reverted: ${(err as Error).message}`);
      }
    },
    [tsxById, compositionScale]
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

        <div className="stage" ref={stageRef} style={{ aspectRatio: `${W} / ${H}` }}>
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
          <div
            className="strip"
            onPointerDown={(e) => {
              const strip = e.currentTarget;
              try { strip.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
              playerRef.current?.pause();
              seekFromStrip(e.clientX, strip);
              const move = (ev: PointerEvent) => seekFromStrip(ev.clientX, strip);
              const up = () => {
                strip.removeEventListener('pointermove', move);
                strip.removeEventListener('pointerup', up);
              };
              strip.addEventListener('pointermove', move);
              strip.addEventListener('pointerup', up);
            }}
          >
            {snap.scenes
              .filter((s) => s.track === 0)
              .map((s) => (
                <div
                  key={s.id}
                  className="seg"
                  style={{
                    left: `${((starts.get(s.id) ?? 0) / totalFrames) * 100}%`,
                    width: `${((s.durationFrames || 150) / totalFrames) * 100}%`,
                  }}
                />
              ))}
            <div className="head" style={{ left: `${(frame / Math.max(1, totalFrames - 1)) * 100}%` }} />
          </div>
          <span className="tc">{timecode(frame)}</span>
        </div>
      </div>
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
