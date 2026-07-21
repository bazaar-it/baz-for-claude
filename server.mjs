#!/usr/bin/env node
/**
 * baz-for-claude — frame-accurate video feedback for AI coding agents.
 *
 * Plays a HOSTED video URL (nothing is downloaded to disk), lets you pause on a
 * frame, type feedback, and delivers that note — with exact frame number,
 * timecode, and a PNG of the frame — into your agent's context.
 *
 * The video is proxied (Range-passthrough) purely so the <video> becomes
 * same-origin and the paused frame can be captured to a canvas. Bytes are piped
 * through, never persisted.
 *
 * Usage:
 *   npx baz-for-claude
 *   npx baz-for-claude --url <video-url> --project <baz-project-id>
 *   npx baz-for-claude --port 7790 --no-thumbs
 *   npx baz-for-claude --replay          # re-print past notes into a fresh session
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, pipeline } from 'node:stream';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { thumbs: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--project' || a === '--project-id') out.project = argv[++i];
    else if (a === '--port') out.port = parseInt(argv[++i], 10);
    else if (a === '--fps') out.fps = parseFloat(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--no-thumbs') out.thumbs = false;
    else if (a === '--no-open') out.noOpen = true;
    else if (a === '--replay') out.replay = true;
    else if (a === '--sync-interval') out.syncInterval = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`
baz-for-claude — frame-accurate video feedback for AI coding agents

  --url <url>        Hosted video URL to load on start
  --project <id>     baz project id — adds scene names via 'baz review --json'
  --port <n>         Port (default 7788). One session = one port.
  --fps <n>          Frames per second (default 30)
  --out <dir>        Override the state directory
  --no-thumbs        Skip frame capture (notes carry timecode only)
  --no-open          Don't auto-open the browser
  --replay           Print every past note for this port, then exit
  --sync-interval <s>  How often to check for a newer export (default 30, 0 = off)

State lives in <tmp>/baz-for-claude/<port>/ — isolated per port so parallel
sessions never cross-post. Point your agent at the tail command printed
on startup.
`);
  process.exit(0);
}

const FPS = args.fps || 30;
const PORT = args.port || 7788;

/**
 * State is isolated PER PORT so parallel Claude sessions never share a notes
 * file or clobber each other's session.json. One session = one port = one
 * state dir = one watcher. An explicit --out overrides everything.
 */
const ROOT = path.join(os.tmpdir(), 'baz-for-claude');
const OUT_DIR = args.out ? path.resolve(args.out) : path.join(ROOT, String(PORT));
const NOTES_FILE = path.join(OUT_DIR, 'notes.jsonl');
const LOG_FILE = path.join(OUT_DIR, 'notes.log');
const FRAMES_DIR = path.join(OUT_DIR, 'frames');
// Reference images the user attaches to a note (pasted/dropped screenshots).
const REFS_DIR = path.join(OUT_DIR, 'refs');
const SESSION_FILE = path.join(OUT_DIR, 'session.json');

await fsp.mkdir(FRAMES_DIR, { recursive: true });
await fsp.mkdir(REFS_DIR, { recursive: true });
// tail -F starts cleanly only if the log exists.
if (!fs.existsSync(LOG_FILE)) await fsp.writeFile(LOG_FILE, '');

// --replay: re-emit every past note so a FRESH agent session can catch up on
// feedback it was never notified about. Prints and exits — no server.
if (args.replay) {
  const txt = await fsp.readFile(NOTES_FILE, 'utf8').catch(() => '');
  let n = 0;
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try {
      console.log(formatNoteLine(JSON.parse(line)));
      n++;
    } catch {
      /* skip a torn line */
    }
  }
  if (!n) console.log(`(no notes yet for port ${PORT} — ${NOTES_FILE})`);
  process.exit(0);
}

// ---------------------------------------------------------------- session state

let session = { url: args.url || '', project: args.project || '', fps: FPS, scenes: [] };

// Resume the last session unless explicitly overridden on the command line.
try {
  const saved = JSON.parse(await fsp.readFile(SESSION_FILE, 'utf8'));
  session = { ...session, ...saved };
  if (args.url) session.url = args.url;
  if (args.project) session.project = args.project;
  if (args.fps) session.fps = args.fps;
} catch {
  /* first run */
}

async function saveSession() {
  await fsp.writeFile(SESSION_FILE, JSON.stringify(session, null, 2));
}

/** Run a baz command and parse its JSON, tolerating a leading ASCII banner. */
async function bazJson(args) {
  const { stdout } = await execFileAsync('baz', args, {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    /* banner in the way — find where the payload starts */
  }
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rest = lines.slice(i).join('\n').trim();
    if (rest.startsWith('{') || rest.startsWith('[')) {
      try {
        return JSON.parse(rest);
      } catch {
        /* keep scanning */
      }
    }
  }
  throw new Error('could not parse baz JSON output');
}

/**
 * Newest COMPLETED export for a project.
 *
 * `baz export list` is account-wide and carries no output URL, so filter by
 * projectId and resolve the URL via `export status`. Only the few most recent
 * are probed — older ones are never what "pull the latest" means.
 */
async function latestExport(projectId) {
  const rows = await bazJson(['export', 'list', '--json']);
  const mine = (Array.isArray(rows) ? rows : [])
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 5);

  for (const row of mine) {
    try {
      const st = await bazJson(['export', 'status', row.id, '--json']);
      if (st.status === 'completed' && st.outputUrl) {
        return { url: st.outputUrl, id: row.id, createdAt: row.createdAt };
      }
    } catch {
      /* skip an export we can't resolve */
    }
  }
  return null;
}

/**
 * Sync to the newest completed export (and optionally the scene map). Used by
 * POST /api/refresh AND a background interval — an agent that re-exports and
 * forgets to ping us shouldn't leave the reviewer staring at the old render.
 */
let syncInFlight = false;
async function syncLatest({ alsoScenes = false } = {}) {
  if (!session.project || syncInFlight) return { changed: false, latest: null };
  syncInFlight = true;
  try {
    const [scenes, latest] = await Promise.all([
      alsoScenes ? loadScenes(session.project) : Promise.resolve(null),
      latestExport(session.project),
    ]);
    if (scenes) session.scenes = scenes;
    const changed = !!latest && latest.url !== session.url;
    if (changed) {
      session.url = latest.url;
      // The scene map likely changed with the render that produced this URL.
      if (!scenes) session.scenes = await loadScenes(session.project);
      console.log(`  synced     newer export ${latest.id} (${latest.createdAt})`);
    }
    await saveSession();
    return { changed, latest };
  } catch (err) {
    console.error(`  ! sync failed: ${err.message.split('\n')[0]}`);
    return { changed: false, latest: null };
  } finally {
    syncInFlight = false;
  }
}

/**
 * Pull scene boundaries from baz so a timestamp can name the scene it lands in.
 * `baz review --json` reports start/duration in SECONDS at 30fps.
 */
async function loadScenes(projectId) {
  if (!projectId) return [];
  try {
    const { stdout } = await execFileAsync(
      'baz',
      ['review', '--json', '--project-id', projectId],
      { maxBuffer: 32 * 1024 * 1024, timeout: 45_000 }
    );
    // The CLI may emit several JSON payloads; take the one carrying scenes.
    let picked = null;
    for (const line of stdout.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const obj = JSON.parse(t);
        if (Array.isArray(obj.scenes)) picked = obj;
      } catch {
        /* not a complete payload on this line */
      }
    }
    if (!picked) {
      try {
        const obj = JSON.parse(stdout);
        if (Array.isArray(obj.scenes)) picked = obj;
      } catch {
        /* give up quietly */
      }
    }
    if (!picked) return [];
    if (picked.timing?.fps) session.fps = picked.timing.fps;
    return picked.scenes
      .filter((s) => (s.track ?? 0) >= 0)
      .map((s) => ({
        id: s.id,
        name: s.name || 'Untitled',
        track: s.track ?? 0,
        start: s.start ?? 0,
        duration: s.duration ?? 0,
      }))
      .sort((a, b) => a.start - b.start || a.track - b.track);
  } catch (err) {
    console.error(`  ! could not load scenes: ${err.message.split('\n')[0]}`);
    return [];
  }
}

// ---------------------------------------------------------------- helpers

/** One human/Claude-readable line per note — the `tail -F` delivery format. */
function formatNoteLine(n) {
  const bits = [`f${n.frame}`, n.timecode];
  if (n.project) bits.push(`proj ${String(n.project).slice(0, 8)}`);
  if (n.scene) bits.push(`scene "${n.scene.name}" ${String(n.scene.id).slice(0, 8)} +${n.scene.frameInScene}f`);
  const under = (n.layers || []).slice(1);
  if (under.length) bits.push(`under: ${under.map((l) => `${l.name}(t${l.track})`).join(', ')}`);
  if (n.frameImage) bits.push(`shot ${n.frameImage}`);
  if (n.refImages && n.refImages.length) {
    bits.push(`refs (READ THESE): ${n.refImages.join(', ')}`);
  }
  if (n.sceneMapStale) {
    bits.push(`STALE EXPORT (timeline ${n.sceneMapStale.timelineDuration.toFixed(2)}s vs video ${n.sceneMapStale.videoDuration.toFixed(2)}s)`);
  }
  return `[NOTE] ${bits.join(' | ')} :: ${n.note}`;
}

function timecode(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function totalOf(scenes) {
  return scenes.reduce((m, s) => Math.max(m, s.start + s.duration), 0);
}

/**
 * Every scene alive at this timestamp, most-specific first.
 *
 * Higher track = drawn on top = more likely what you're pointing at, EXCEPT for
 * scenes spanning (nearly) the whole video — audio beds and full-length
 * backgrounds sit on upper tracks but are never the thing being critiqued, so
 * they sort last.
 */
function activeScenes(sec, scenes) {
  const total = totalOf(scenes);
  return scenes
    .filter((s) => sec >= s.start && sec < s.start + s.duration)
    .map((s) => ({ ...s, spanning: total > 0 && s.duration >= total * 0.95 }))
    .sort((a, b) => Number(a.spanning) - Number(b.spanning) || b.track - a.track);
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Generous: a note can carry a captured frame plus up to 8 reference screenshots.
async function readBody(req, limit = 72 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- routes

async function handleStream(req, res, target) {
  let upstream;
  try {
    upstream = new URL(target);
  } catch {
    return send(res, 400, { error: 'bad url' });
  }
  if (!/^https?:$/.test(upstream.protocol)) {
    return send(res, 400, { error: 'only http(s) urls' });
  }

  const fwd = {};
  if (req.headers.range) fwd.Range = req.headers.range;

  // CRITICAL for multi-session load: every seek makes the browser abort its
  // in-flight Range request. Without propagating that abort upstream, each
  // seek leaves an orphaned S3 download holding a socket and buffering data.
  // Scrubbing = dozens of seeks; 12 sessions = a machine-slowing pileup.
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream, { headers: fwd, redirect: 'follow', signal: ac.signal });
  } catch (err) {
    if (ac.signal.aborted) return; // client already gone — nothing to answer
    return send(res, 502, { error: `upstream fetch failed: ${err.message}` });
  }

  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    return send(res, upstreamRes.status, { error: `upstream returned ${upstreamRes.status}` });
  }

  const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
  // Render URLs (S3/R2) are content-unique — a re-export mints a new URL — so
  // their bytes are immutable: let the browser's own (bounded, self-evicting)
  // HTTP cache keep them instead of re-downloading 50MB on every reload.
  const immutable = /(^|\.)amazonaws\.com$|(^|\.)r2\.dev$|(^|\.)cloudflarestorage\.com$/.test(upstream.hostname);
  const headers = {
    'Cache-Control': immutable ? 'public, max-age=86400, immutable' : 'public, max-age=300',
  };
  for (const h of pass) {
    const v = upstreamRes.headers.get(h);
    if (v) headers[h] = v;
  }
  if (!headers['accept-ranges']) headers['accept-ranges'] = 'bytes';

  res.writeHead(upstreamRes.status, headers);
  if (req.method === 'HEAD' || !upstreamRes.body) return res.end();

  // pipeline (unlike .pipe) tears BOTH streams down when either side dies.
  pipeline(Readable.fromWeb(upstreamRes.body), res, () => {
    /* abort on seek is normal traffic, upstream hiccups have no one to tell */
  });
}

async function handleNote(req, res) {
  const raw = await readBody(req);
  const payload = JSON.parse(raw.toString('utf8'));

  const fps = session.fps || FPS;
  const time = Number(payload.time) || 0;
  const frame = Math.round(time * fps);
  const active = activeScenes(time, session.scenes);
  const scene = active[0] || null;

  // Scene markers only line up if this export matches the CURRENT timeline. Edit
  // scenes after exporting and every timestamp silently drifts, so say so loudly
  // rather than attributing feedback to the wrong scene.
  const timeline = totalOf(session.scenes);
  const vidDur = Number(payload.videoDuration) || 0;
  const stale = timeline > 0 && vidDur > 0 && Math.abs(timeline - vidDur) > 0.2;

  const stamp = new Date().toISOString();
  // Random suffix: two notes in the same millisecond must not share a PNG path.
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let framePath = null;
  if (args.thumbs && payload.thumb && typeof payload.thumb === 'string') {
    const b64 = payload.thumb.replace(/^data:image\/\w+;base64,/, '');
    framePath = path.join(FRAMES_DIR, `f${String(frame).padStart(5, '0')}-${id}.png`);
    await fsp.writeFile(framePath, Buffer.from(b64, 'base64'));
  }

  // Reference images pasted/dropped into the composer — "make it look like this".
  // Saved beside the note so the agent can Read them like any other file.
  const refPaths = [];
  if (Array.isArray(payload.refs)) {
    for (const [i, dataUrl] of payload.refs.slice(0, 8).entries()) {
      if (typeof dataUrl !== 'string') continue;
      const m = /^data:image\/(png|jpeg|webp|gif);base64,/.exec(dataUrl);
      if (!m) continue;
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const p = path.join(REFS_DIR, `ref-${id}-${i + 1}.${ext}`);
      await fsp.writeFile(p, Buffer.from(dataUrl.slice(m[0].length), 'base64'));
      refPaths.push(p);
    }
  }

  const note = {
    id,
    at: stamp,
    note: String(payload.note || '').trim(),
    time,
    frame,
    timecode: timecode(time),
    fps,
    project: session.project || null,
    video: session.url || null,
    scene: scene
      ? {
          id: scene.id,
          name: scene.name,
          track: scene.track,
          startSec: scene.start,
          frameInScene: Math.round((time - scene.start) * fps),
        }
      : null,
    // Everything stacked at this frame, so a note about an overlay isn't
    // silently pinned to whichever layer happened to sort first.
    layers: active.map((s) => ({
      id: s.id,
      name: s.name,
      track: s.track,
      frameInScene: Math.round((time - s.start) * fps),
    })),
    frameImage: framePath,
    refImages: refPaths,
    ...(stale
      ? { sceneMapStale: { timelineDuration: timeline, videoDuration: vidDur } }
      : {}),
  };

  // Two files per note: JSONL is the data of record; notes.log is the same
  // note preformatted so a plain `tail -F` (≈1MB) can deliver it to Claude —
  // no 28MB node watcher needed per session.
  await fsp.appendFile(NOTES_FILE, JSON.stringify(note) + '\n');
  await fsp.appendFile(LOG_FILE, formatNoteLine(note) + '\n');

  const sceneBit = note.scene
    ? ` | scene "${note.scene.name}" (${note.scene.id.slice(0, 8)}) +${note.scene.frameInScene}f`
    : '';
  console.log(`  note @ ${note.timecode} f${note.frame}${sceneBit} — ${note.note.slice(0, 60)}`);

  send(res, 200, { ok: true, note });
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // Read per-request so the UI can be edited without a restart.
      const html = await fsp.readFile(path.join(__dirname, 'ui.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (url.pathname === '/stream') {
      const target = url.searchParams.get('u');
      if (!target) return send(res, 400, { error: 'missing u' });
      return handleStream(req, res, target);
    }

    if (url.pathname === '/frame') {
      const p = path.resolve(url.searchParams.get('p') || '');
      // Only ever serve images from our own frames/refs dirs.
      if (!p.startsWith(FRAMES_DIR + path.sep) && !p.startsWith(REFS_DIR + path.sep)) {
        return send(res, 403, { error: 'forbidden' });
      }
      if (!fs.existsSync(p)) return send(res, 404, { error: 'gone' });
      const ext = path.extname(p).slice(1).toLowerCase();
      const type = ext === 'jpg' ? 'jpeg' : ext;
      res.writeHead(200, {
        'Content-Type': `image/${['png', 'jpeg', 'webp', 'gif'].includes(type) ? type : 'png'}`,
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(p).pipe(res);
    }

    if (url.pathname === '/api/session' && req.method === 'GET') {
      return send(res, 200, { ...session, thumbs: args.thumbs, notesFile: NOTES_FILE });
    }

    if (url.pathname === '/api/session' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 64)).toString('utf8'));
      const projectChanged = body.project !== undefined && body.project !== session.project;
      if (body.url !== undefined) session.url = String(body.url).trim();
      if (body.project !== undefined) session.project = String(body.project).trim();
      if (projectChanged) {
        session.scenes = await loadScenes(session.project);
        console.log(`  loaded ${session.scenes.length} scenes for ${session.project.slice(0, 8)}`);
      }
      await saveSession();
      return send(res, 200, { ...session, thumbs: args.thumbs });
    }

    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      if (!session.project) return send(res, 400, { error: 'no project id set' });
      const { changed, latest } = await syncLatest({ alsoScenes: true });
      return send(res, 200, { ...session, changed, latest });
    }

    if (url.pathname === '/api/note' && req.method === 'POST') {
      return handleNote(req, res);
    }

    if (url.pathname === '/api/notes' && req.method === 'GET') {
      let lines = [];
      try {
        const txt = await fsp.readFile(NOTES_FILE, 'utf8');
        lines = txt.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        /* no notes yet */
      }
      return send(res, 200, { notes: lines.slice(-50) });
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

/**
 * No port auto-increment: silently binding 7789 while the launch config and
 * the watcher still point at 7788 means you review one session's video while
 * your notes stream into ANOTHER session's chat. Fail loud instead.
 */
server.once('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  port ${PORT} is already in use — probably another baz-for-claude session.`);
    console.error(`  each session needs its own port (state is isolated per port):\n`);
    console.error(`    npx baz-for-claude --port ${PORT + 2} --url <video-url>\n`);
    process.exit(2);
  }
  console.error(err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', async () => {
  const addr = `http://localhost:${PORT}`;
  if (session.project) {
    // Boot sync: scene map + newest completed export. An explicit --url still
    // seeds the starting video, but auto-sync takes over from there.
    session.scenes = await loadScenes(session.project);
    if (!args.url) await syncLatest();
    await saveSession();
  } else {
    await saveSession();
  }

  // Background auto-sync: a re-export changes the URL server-side and the open
  // page swaps within ~5s — nobody has to remember to press or POST anything.
  // POST /api/refresh remains for an immediate swap.
  const syncEvery = (args.syncInterval ?? 30) * 1000;
  if (session.project && syncEvery > 0) {
    setInterval(() => syncLatest(), syncEvery).unref();
  }

  console.log(`\n  baz-for-claude   ${addr}`);
  console.log(`  state      ${OUT_DIR}`);
  console.log(`  watch      tail -n 0 -F ${LOG_FILE}`);
  if (session.url) console.log(`  video      ${session.url.slice(0, 78)}`);
  if (session.scenes.length) console.log(`  scenes     ${session.scenes.length} loaded`);
  if (session.project && syncEvery > 0) console.log(`  auto-sync  every ${syncEvery / 1000}s (newest completed export)`);
  console.log('');
  if (!args.noOpen) {
    execFile('open', [addr], () => {});
  }
});
