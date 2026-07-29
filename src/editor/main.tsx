/**
 * baz-for-claude editor — Phase 0 spike.
 *
 * Proves the risky core end-to-end: live-compile one scene's TSX, play it in
 * @remotion/player, click an element on the canvas (data-baz tags → source
 * loc), drag it, write the wrapper patch back through baz, recompile.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Player } from '@remotion/player';
import { installGlobals } from './globals';
import { compileScene } from './compile';
import { applyTranslate } from './patch';

installGlobals();

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

interface Selection {
  loc: string; // "sceneId:line:col"
  el: HTMLElement;
  tagName: string;
}

function App() {
  const [snap, setSnap] = useState<ProjectSnapshot | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [tsxById, setTsxById] = useState<Record<string, string>>({});
  const [editMode, setEditMode] = useState(true);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [status, setStatus] = useState<string>('');
  const [compileNonce, setCompileNonce] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    sel: Selection;
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
        const first = d.scenes.find((s: SceneInfo) => s.tsxCode);
        if (first) setSceneId(first.id);
      })
      .catch((e) => setLoadErr(e.message));
  }, []);

  const scene = snap?.scenes.find((s) => s.id === sceneId) || null;
  const tsx = sceneId ? tsxById[sceneId] : undefined;

  // ---- compile selected scene ----------------------------------------------
  const compiled = useMemo(() => {
    if (!tsx || !sceneId) return null;
    return compileScene(tsx, sceneId);
    // compileNonce forces recompiles after saves even if tsx string is reused
  }, [tsx, sceneId, compileNonce]);

  const lazyComponent = useMemo(() => {
    if (!compiled || compiled.error) return null;
    const url = compiled.blobUrl;
    return () => import(/* @vite-ignore */ url).then((m) => ({ default: m.default }));
  }, [compiled]);

  // ---- canvas hit-testing ---------------------------------------------------
  const pickAt = useCallback((x: number, y: number): Selection | null => {
    const overlay = stageRef.current?.querySelector<HTMLElement>('.hit-overlay');
    if (!overlay) return null;
    overlay.style.pointerEvents = 'none';
    const raw = document.elementFromPoint(x, y) as HTMLElement | null;
    overlay.style.pointerEvents = 'auto';
    let el: HTMLElement | null = raw;
    while (el && el !== stageRef.current) {
      const loc = el.getAttribute('data-baz');
      if (loc) return { loc, el, tagName: el.tagName.toLowerCase() };
      el = el.parentElement;
    }
    return null;
  }, []);

  const compositionScale = useCallback((): number => {
    const stage = stageRef.current;
    if (!stage || !snap) return 1;
    return stage.getBoundingClientRect().width / snap.project.width;
  }, [snap]);

  // ---- drag lifecycle -------------------------------------------------------
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const sel = pickAt(e.clientX, e.clientY);
      setSelection(sel);
      if (!sel) return;
      dragRef.current = {
        sel,
        startX: e.clientX,
        startY: e.clientY,
        origTransform: sel.el.style.transform || '',
        moved: false,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pickAt]
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    // Instant visual feedback: transform the live DOM node during the drag.
    d.sel.el.style.transform = `translate(${dx}px, ${dy}px) ${d.origTransform}`.trim();
  }, []);

  const onPointerUp = useCallback(
    async (e: React.PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d || !d.moved || !sceneId) return;

      const scale = compositionScale();
      const dx = Math.round(((e.clientX - d.startX) / scale) * 10) / 10;
      const dy = Math.round(((e.clientY - d.startY) / scale) * 10) / 10;
      d.sel.el.style.transform = d.origTransform; // recompile will own it now

      const [, lineS, colS] = d.sel.loc.split(':');
      const current = tsxById[sceneId];
      const patched = applyTranslate(current, Number(lineS), Number(colS), dx, dy);
      if (!patched) {
        setStatus(`⚠ couldn't patch ${d.sel.tagName} mechanically — send it as a note instead`);
        return;
      }

      // Optimistic: recompile locally first, then persist through baz.
      setTsxById((m) => ({ ...m, [sceneId]: patched }));
      setStatus(`saving translate(${dx}, ${dy}) on <${d.sel.tagName}>…`);
      try {
        const r = await fetch('/api/editor/scene-code', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneId, code: patched }),
        });
        const res = await r.json();
        if (!r.ok) throw new Error(res.error || 'save failed');
        if (res.compilationError) {
          // Server compile rejected our patch — roll back rather than ship a broken scene.
          setTsxById((m) => ({ ...m, [sceneId]: current }));
          setCompileNonce((n) => n + 1);
          setStatus(`✗ server compile error, patch reverted: ${String(res.compilationError).slice(0, 120)}`);
          return;
        }
        setStatus(`✓ saved <${d.sel.tagName}> translate(${dx}px, ${dy}px)`);
      } catch (err) {
        setTsxById((m) => ({ ...m, [sceneId]: current }));
        setCompileNonce((n) => n + 1);
        setStatus(`✗ save failed, reverted: ${(err as Error).message}`);
      }
    },
    [sceneId, tsxById, compositionScale]
  );

  // ---- render ---------------------------------------------------------------
  if (loadErr) return <div className="pad err">Failed to load project: {loadErr}</div>;
  if (!snap) return <div className="pad dim">Loading project…</div>;

  const W = snap.project.width || 1920;
  const H = snap.project.height || 1080;

  return (
    <div className="app">
      <div className="side">
        <div className="brand">baz <span>editor spike</span></div>
        <div className="proj">{snap.project.title}</div>
        {snap.scenes.map((s) => (
          <button
            key={s.id}
            className={'scene' + (s.id === sceneId ? ' on' : '') + (s.hasCode ? '' : ' nocode')}
            onClick={() => { setSelection(null); setSceneId(s.id); }}
          >
            <i>t{s.track}</i> {s.name}
          </button>
        ))}
      </div>

      <div className="main">
        <div className="bar">
          <label>
            <input type="checkbox" checked={editMode} onChange={(e) => setEditMode(e.target.checked)} />
            Edit mode (off = player controls)
          </label>
          <span className="sel">
            {selection ? `selected <${selection.tagName}> @ ${selection.loc.split(':').slice(1).join(':')}` : 'click an element'}
          </span>
          <span className="status">{status}</span>
        </div>

        <div className="stage" ref={stageRef} style={{ aspectRatio: `${W} / ${H}` }}>
          {compiled?.error && <div className="pad err">Compile error: {compiled.error}</div>}
          {lazyComponent && scene && (
            <Player
              key={`${sceneId}-${compileNonce}-${compiled!.blobUrl}`}
              lazyComponent={lazyComponent as never}
              durationInFrames={Math.max(1, scene.durationFrames || 150)}
              compositionWidth={W}
              compositionHeight={H}
              fps={30}
              controls={!editMode}
              loop
              style={{ width: '100%', height: '100%' }}
              acknowledgeRemotionLicense
            />
          )}
          {editMode && (
            <div
              className="hit-overlay"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          )}
          {selection && <SelectionBox target={selection.el} stage={stageRef.current} />}
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
