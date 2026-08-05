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
import crypto from 'node:crypto';

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
    else if (a === '--voice-model') out.voiceModel = argv[++i];
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
  --voice-model <id>   OpenAI realtime model for voice review (default gpt-realtime-2.1)

Voice: export OPENAI_API_KEY and click the mic in the UI to talk through the
video with a realtime agent that has the scene map, can read scene code, see
the paused frame, and files agreed changes as notes for your coding agent.
The key stays server-side; the browser only ever gets a ~60s ephemeral token.

State lives in <tmp>/baz-for-claude/<port>/ — isolated per port so parallel
sessions never cross-post. Point your agent at the tail command printed
on startup.
`);
  process.exit(0);
}

const FPS = args.fps || 30;
const PORT = args.port || 7788;

/**
 * State splits two ways, because the two halves have different owners:
 *
 *   per PORT     notes.log, session.json — the delivery channel and "what is
 *                this window showing". The log path must stay put or the
 *                agent's `tail -F` breaks mid-session.
 *   per PROJECT  notes.jsonl, frames/, refs/ — the feedback itself. Notes
 *                belong to a video, not to a port number, so reusing a port
 *                for a different project must NOT drag the old notes along,
 *                and reopening a project brings its own history back.
 *
 * An explicit --out collapses both into one directory.
 */
const ROOT = path.join(os.tmpdir(), 'baz-for-claude');
const PROJECTS_ROOT = path.join(ROOT, 'projects');
const OUT_DIR = args.out ? path.resolve(args.out) : path.join(ROOT, String(PORT));
const LOG_FILE = path.join(OUT_DIR, 'notes.log');
const SESSION_FILE = path.join(OUT_DIR, 'session.json');

await fsp.mkdir(OUT_DIR, { recursive: true });
// tail -F starts cleanly only if the log exists.
if (!fs.existsSync(LOG_FILE)) await fsp.writeFile(LOG_FILE, '');

/**
 * Which video's notes are these? Prefer the baz project id. Failing that, baz
 * render URLs embed the project id, so a re-export (new URL, same project)
 * still lands on the same history. Anything else falls back to the URL itself.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The baz project id this note belongs to — the id the agent must pin with
 * `--project-id` so a concurrent `baz project use` in another session can't
 * redirect the edit to the wrong project. Prefer the explicit project; else
 * the UUID a baz render URL embeds; else null (not a baz project).
 */
function projectIdFor(project, url) {
  if (project) return String(project).trim();
  const m = url ? UUID_RE.exec(url) : null;
  return m ? m[0].toLowerCase() : null;
}

function projectKey(project, url) {
  const id = projectIdFor(project, url);
  if (id) return 'p-' + id;
  if (url) return 'u-' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
  return null; // nothing loaded yet
}

// Rebound by useProject() whenever the loaded video changes.
let CURRENT_KEY = null;
let PROJ_DIR = OUT_DIR;
let NOTES_FILE = path.join(OUT_DIR, 'notes.jsonl');
let FRAMES_DIR = path.join(OUT_DIR, 'frames');
let REFS_DIR = path.join(OUT_DIR, 'refs');

async function useProject(key) {
  if (args.out) { // --out pins everything to one directory
    await fsp.mkdir(FRAMES_DIR, { recursive: true });
    await fsp.mkdir(REFS_DIR, { recursive: true });
    return;
  }
  const next = key || '_unassigned';
  if (next === CURRENT_KEY) return;
  CURRENT_KEY = next;
  PROJ_DIR = path.join(PROJECTS_ROOT, next.replace(/[^\w.-]/g, '_'));
  NOTES_FILE = path.join(PROJ_DIR, 'notes.jsonl');
  FRAMES_DIR = path.join(PROJ_DIR, 'frames');
  REFS_DIR = path.join(PROJ_DIR, 'refs');
  await fsp.mkdir(FRAMES_DIR, { recursive: true });
  await fsp.mkdir(REFS_DIR, { recursive: true });
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

// An explicit --url with no --project means "show me THIS video". If the
// resumed session names a different project than the URL does, that project is
// left over from whatever last used this port — drop it, or we'd key the notes
// (and the scene names) to the wrong video.
if (args.url && !args.project && session.project) {
  const inUrl = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(args.url);
  if (!inUrl || inUrl[0].toLowerCase() !== session.project.toLowerCase()) {
    session.project = '';
    session.scenes = [];
  }
}

// Point at the right project's history before anything reads or writes notes.
await useProject(projectKey(session.project, session.url));

async function saveSession() {
  await fsp.writeFile(SESSION_FILE, JSON.stringify(session, null, 2));
}

// --replay: re-emit every past note so a FRESH agent session can catch up on
// feedback it was never notified about. Prints and exits — no server.
// Resolves the same project the session points at, so it replays that video's
// notes rather than whatever last used this port.
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
  if (!n) console.log(`(no notes yet for ${CURRENT_KEY || 'this project'} — ${NOTES_FILE})`);
  process.exit(0);
}

/**
 * Direct tRPC call with the CLI's own credentials, for the procedures the CLI
 * doesn't wrap (scenes.reorderScenes). Same wire format as cli/src/lib/api.ts:
 * POST {apiUrl}/api/trpc/<proc> with {"json": input} and x-api-key.
 */
async function bazTrpc(procedure, input) {
  const cfg = JSON.parse(
    await fsp.readFile(path.join(os.homedir(), '.bazaar', 'config.json'), 'utf8')
  );
  if (!cfg.apiKey) throw new Error('no baz api key — run: baz auth login');
  const apiUrl = cfg.apiUrl || 'https://bazaar.it';
  const res = await fetch(`${apiUrl}/api/trpc/${procedure}`, {
    method: 'POST',
    headers: { 'x-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (body && body.error && body.error.json && body.error.json.message) ||
      (body && body.error && body.error.message) ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body && body.result && body.result.data
    ? (body.result.data.json ?? body.result.data)
    : body;
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
      // Same project, new export — key is unchanged, but stay in step anyway.
      await useProject(projectKey(session.project, session.url));
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
// ---------------------------------------------------------------- voice review
// A realtime voice agent (OpenAI Realtime API over WebRTC) the user talks to
// while watching. It gets a digest of every scene's code up front, can pull
// full TSX on demand, see the paused frame, and files agreed changes as notes
// into the normal pipeline — it never edits anything itself.

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const VOICE_MODEL = args.voiceModel || 'gpt-realtime-2.1';

/** Full TSX for every scene, via the authenticated CLI — pinned, read-only. */
async function fetchAllSceneCode(projectId) {
  const { stdout } = await execFileAsync(
    'baz',
    ['scenes', 'code', '--all', '--project-id', projectId],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }
  );
  return stdout;
}

/** Split the --all dump back into per-scene blocks keyed by scene id. */
function splitSceneCode(allCode) {
  const blocks = {};
  const re = /\/\/ =+\n\/\/ Scene: (.+)\n\/\/ ID: ([0-9a-f-]+)\n\/\/ =+\n/g;
  const marks = [];
  let m;
  while ((m = re.exec(allCode))) marks.push({ name: m[1].trim(), id: m[2], end: re.lastIndex });
  for (let i = 0; i < marks.length; i++) {
    const upto = i + 1 < marks.length ? allCode.lastIndexOf('// =', allCode.indexOf(`// ID: ${marks[i + 1].id}`)) : allCode.length;
    blocks[marks[i].id] = { name: marks[i].name, code: allCode.slice(marks[i].end, upto).trim() };
  }
  return blocks;
}

/**
 * Compact per-scene digest the agent holds in context for the whole call:
 * timing, the text actually on screen, palette, fonts, motion density. Rule-
 * based on purpose — deterministic, instant, and free.
 */
function digestScene(code) {
  const CSS_WORDS = new Set([
    'absolute', 'relative', 'fixed', 'hidden', 'visible', 'none', 'block', 'flex',
    'center', 'transparent', 'pointer', 'nowrap', 'uppercase', 'lowercase', 'cover',
    'contain', 'column', 'row', 'bold', 'normal', 'italic', 'left', 'right', 'top',
    'bottom', 'middle', 'baseline', 'inherit', 'auto', 'wrap', 'grid', 'inline',
  ]);
  const texts = [];
  for (const m of code.matchAll(/"([^"\\\n]{3,80})"/g)) {
    const s = m[1].trim();
    // Human words only: no CSS functions/units/urls/selectors/JSX fragments.
    if (/[(){}<>=;_:]|https?|px\b|deg\b|%\)|\.(png|jpe?g|mp4|svg|woff2?)$/i.test(s)) continue;
    if (/^[#.,\d\s-]|^rgba?|^var\b/i.test(s)) continue;
    // CSS keyword chains: border-box, tabular-nums, inline-block, sans-serif…
    if (/^[a-z]+(-[a-z0-9]+)+$/.test(s)) continue;
    if (CSS_WORDS.has(s.toLowerCase())) continue;
    // Real on-screen copy has a space, or is one long word (a headline word).
    if (!s.includes(' ') && s.length < 9) continue;
    if (!/[A-Za-z]{3}/.test(s)) continue;
    if (!texts.includes(s)) texts.push(s);
    if (texts.length >= 12) break;
  }
  const colors = [...new Set([...code.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]))].slice(0, 6);
  const fonts = [...new Set([...code.matchAll(/loadFont\?\.\("([^"]+)"/g)].map((m) => m[1]))];
  const springs = (code.match(/spring\(/g) || []).length;
  const interps = (code.match(/interpolate\(/g) || []).length;
  const media = /OffthreadVideo|<Img|\.mp4|Video\b/.test(code) ? 'uses media assets' : 'pure motion graphics';
  return { texts, colors, fonts, motion: `${interps} interpolations, ${springs} springs`, media };
}

let digestCache = { key: null, digest: '', blocks: {} };

async function getProjectDigest() {
  const pid = projectIdFor(session.project, session.url);
  if (!pid) return { digest: '(no baz project loaded — video URL only, no scene map)', blocks: {} };
  if (digestCache.key === pid && digestCache.digest) return digestCache;

  const all = await fetchAllSceneCode(pid);
  const blocks = splitSceneCode(all);
  const byId = Object.fromEntries(session.scenes.map((s) => [s.id, s]));
  const lines = [];
  const ordered = session.scenes.length
    ? [...session.scenes].sort((a, b) => a.start - b.start || a.track - b.track)
    : Object.keys(blocks).map((id) => ({ id }));

  for (const s of ordered) {
    const b = blocks[s.id];
    if (!b) continue;
    const d = digestScene(b.code);
    const t = byId[s.id];
    const fps = session.fps || 30;
    const timing = t
      ? `track ${t.track}, ${t.start.toFixed(2)}s → ${(t.start + t.duration).toFixed(2)}s (f${Math.round(t.start * fps)}–f${Math.round((t.start + t.duration) * fps)})`
      : 'timing unknown';
    lines.push(
      `• ${b.name} [${s.id}]\n` +
      `  ${timing} · ${d.media} · ${d.motion}\n` +
      (d.texts.length ? `  on-screen text: ${d.texts.map((x) => `"${x}"`).join(', ').slice(0, 300)}\n` : '') +
      (d.colors.length ? `  palette: ${d.colors.join(' ')}${d.fonts.length ? ' · fonts: ' + d.fonts.join(', ') : ''}` : '')
    );
  }
  const digest = lines.join('\n').slice(0, 16000);
  digestCache = { key: pid, digest, blocks };
  return digestCache;
}

const DIRECTOR_BRIEF = `You are a launch-video creative director doing a live review with the user, who is watching their video and talking to you.

Craft you hold them to:
- The hook is everything: the first 2 seconds must earn the next 40. If the opening doesn't grab, say so first.
- One idea per scene. A scene that makes two points makes none.
- Every scene must EARN its duration — flag anything that overstays, name the exact seconds to cut.
- Cuts should land on motion or shape matches; a dead cut is a wasted transition.
- Type discipline: one hierarchy, no more than two families, big enough to read on a phone.
- Pacing has a curve: open hot, breathe in the middle, accelerate to the CTA. Say where the curve sags.
- The CTA is one action, stated once, unmissable.

How you work:
- You have a scene-by-scene digest of the actual code below. Use it — refer to scenes by name and to moments by timecode or frame.
- Ask sharp questions, ONE at a time, and prefer questions the user hasn't thought of ("who is this for?", "what should someone feel at 0:10?", "why does this scene deserve 4 seconds?").
- When the discussion zooms into a scene, call get_scene_code to read its real TSX before making claims about it.
- Call see_frame to look at the exact frame the user is paused on when they say "this", "here", or describe something visual.
- The playhead position arrives as system messages — that's where the user is looking right now.
- You NEVER edit anything. When you and the user agree on a change, call file_note with ONE precise, self-contained instruction (name the scene, the frames, the exact change). The user's coding agent executes notes. Never file a note the user hasn't agreed to; confirm aloud first.
- Keep spoken replies short — two or three sentences, then stop. This is a conversation, not a lecture.
- Be candid. If a scene is weak, say it plainly and say why.`;

const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'get_scene_code',
    description: 'Read the full TSX source of one scene of the video being reviewed. Use before making detailed claims about a scene.',
    parameters: {
      type: 'object',
      properties: { sceneId: { type: 'string', description: 'Scene id (or exact scene name) from the digest' } },
      required: ['sceneId'],
    },
  },
  {
    type: 'function',
    name: 'see_frame',
    description: 'Look at the exact video frame the user is currently paused on. Returns an image of it.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'get_playhead',
    description: 'Get the current playhead position: time, frame number, and which scene it is in.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'file_note',
    description: 'File ONE agreed change as a note for the coding agent to execute. Only after the user has explicitly agreed. The note must be self-contained: scene name, frames or timecode, and the exact change.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The precise instruction' },
        atSeconds: { type: 'number', description: 'The moment in the video this note is about (defaults to current playhead)' },
      },
      required: ['note'],
    },
  },
];

/**
 * Full scene TSX rides in the session context by default, so the agent has
 * read every line of the film before the first word is spoken — the digest
 * stays on top as the map. Budgeted: scenes past the cap fall back to
 * get_scene_code, in timeline order so the opening scenes always make it.
 */
const FULL_CODE_BUDGET = 150_000; // chars of TSX in-context (~35k tokens)

async function buildVoiceInstructions() {
  const { digest, blocks } = await getProjectDigest();
  const pid = projectIdFor(session.project, session.url);
  const total = totalOf(session.scenes);

  let codeSection = '';
  const skipped = [];
  const order = session.scenes.length
    ? [...session.scenes].sort((a, b) => a.start - b.start || a.track - b.track).map((s) => s.id)
    : Object.keys(blocks);
  let used = 0;
  for (const id of order) {
    const b = blocks[id];
    if (!b) continue;
    if (used + b.code.length > FULL_CODE_BUDGET) { skipped.push(b.name); continue; }
    used += b.code.length;
    codeSection += `\n--- SCENE: ${b.name} [${id}] ---\n${b.code}\n`;
  }

  return (
    DIRECTOR_BRIEF +
    `\n\n=== THE VIDEO UNDER REVIEW ===\n` +
    (pid ? `baz project id: ${pid}\n` : '') +
    (total ? `total duration: ${total.toFixed(2)}s at ${session.fps || 30}fps\n` : '') +
    `\nScene digest (the map):\n${digest}` +
    (codeSection
      ? `\n\n=== FULL SCENE CODE (you have already read all of this) ===\n${codeSection}`
      : '') +
    (skipped.length
      ? `\n\n(Scenes not included above — call get_scene_code to read them: ${skipped.join(', ')})`
      : '')
  );
}

function formatNoteLine(n) {
  const bits = [`f${n.frame}`, n.timecode];
  if (n.via === 'voice') bits.push('via VOICE agent (already discussed and agreed with the user aloud)');
  // Full id, not truncated: the agent copies this straight into --project-id.
  if (n.project) bits.push(`project ${n.project} (pin: --project-id ${n.project})`);
  if (n.scene) bits.push(`scene "${n.scene.name}" ${String(n.scene.id).slice(0, 8)} +${n.scene.frameInScene}f`);
  const under = (n.layers || []).slice(1);
  if (under.length) bits.push(`under: ${under.map((l) => `${l.name}(t${l.track})`).join(', ')}`);
  if (n.frameImage) bits.push(`shot ${n.frameImage}`);
  if (n.transition) {
    const t = n.transition;
    bits.push(
      `MATCH CUT at ${t.atSec.toFixed(2)}s — "${t.fromScene.name}" ${String(t.fromScene.id).slice(0, 8)} ` +
      `last frame f${t.fromScene.lastFrame} -> "${t.toScene.name}" ${String(t.toScene.id).slice(0, 8)} ` +
      `first frame f${t.toScene.firstFrame}`
    );
  }
  if (n.refImages && n.refImages.length) {
    bits.push(
      n.transition
        ? `frames (READ BOTH — outgoing then incoming): ${n.refImages.join(', ')}`
        : `refs (READ THESE): ${n.refImages.join(', ')}`
    );
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
    via: payload.voice ? 'voice' : 'ui',
    note: String(payload.note || '').trim(),
    time,
    frame,
    timecode: timecode(time),
    fps,
    // Full baz project id (from --project or the render URL) — the id the agent
    // must pin on every baz command so the edit can't leak to another project.
    project: projectIdFor(session.project, session.url),
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
    // Set when the note came from the ⇄ match-cut grab: the two refs above are
    // the last frame of `from` and the first frame of `to`, in that order.
    transition: payload.transition && typeof payload.transition === 'object'
      ? payload.transition
      : null,
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

    // ---- editor (spike) ----------------------------------------------------
    if (url.pathname === '/editor') {
      const html = await fsp.readFile(path.join(__dirname, 'dist', 'editor.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (url.pathname.startsWith('/dist/')) {
      const p = path.resolve(path.join(__dirname, url.pathname.slice(1)));
      if (!p.startsWith(path.join(__dirname, 'dist') + path.sep) || !fs.existsSync(p)) {
        return send(res, 404, { error: 'not found' });
      }
      const type = p.endsWith('.js') ? 'application/javascript' : p.endsWith('.html') ? 'text/html' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return fs.createReadStream(p).pipe(res);
    }

    if (url.pathname === '/api/editor/project' && req.method === 'GET') {
      if (!session.project) return send(res, 400, { error: 'editor needs --project <baz-project-id>' });
      // One structured call for the whole project incl. all scene TSX.
      const snap = await bazJson(['state', '--json', '--include-code', '--project-id', session.project]);
      return send(res, 200, snap);
    }

    if (url.pathname === '/api/editor/positions' && req.method === 'POST') {
      if (!session.project) return send(res, 400, { error: 'no project pinned' });
      const body = JSON.parse((await readBody(req, 1024 * 256)).toString('utf8'));
      if (!Array.isArray(body.updates) || !body.updates.length) {
        return send(res, 400, { error: 'updates[] required' });
      }
      try {
        // The CLI positions path is the one write that reports server truth
        // (resolved[].finalTrack, autoPlaced) — use it rather than raw tRPC.
        const result = await bazJson([
          'scenes', 'positions',
          '--updates-json', JSON.stringify(body.updates),
          '--apply',
          '--project-id', session.project,
          '--json',
        ]);
        return send(res, 200, result);
      } catch (err) {
        return send(res, 500, { error: err && err.message ? err.message : String(err) });
      }
    }

    if (url.pathname === '/api/editor/reorder' && req.method === 'POST') {
      if (!session.project) return send(res, 400, { error: 'no project pinned' });
      const body = JSON.parse((await readBody(req, 1024 * 256)).toString('utf8'));
      if (!Array.isArray(body.sceneIds) || !body.sceneIds.length) {
        return send(res, 400, { error: 'sceneIds[] required' });
      }
      try {
        // Track-0 order IS its timing, but `scenes reorder` has no CLI surface
        // — call the same tRPC procedure the web timeline uses, with the same
        // credentials the CLI reads.
        const result = await bazTrpc('scenes.reorderScenes', {
          projectId: session.project,
          sceneIds: body.sceneIds,
        });
        return send(res, 200, { success: true, result });
      } catch (err) {
        return send(res, 500, { error: err && err.message ? err.message : String(err) });
      }
    }

    if (url.pathname === '/api/editor/scene-code' && req.method === 'PUT') {
      if (!session.project) return send(res, 400, { error: 'no project pinned' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (!body.sceneId || typeof body.code !== 'string') {
        return send(res, 400, { error: 'sceneId and code required' });
      }
      const tmp = path.join(os.tmpdir(), `baz-editor-${Date.now().toString(36)}.tsx`);
      await fsp.writeFile(tmp, body.code, 'utf8');
      try {
        // Pinned project id on the write — the anti-leak rule. NOTE: set-code
        // reports compile failures in-band; success here does NOT mean valid
        // code, the client must check compilationError.
        const result = await bazJson([
          'scenes', 'set-code', body.sceneId,
          '--file', tmp,
          '--project-id', session.project,
          '--json',
        ]);
        return send(res, 200, {
          success: true,
          compilationError: result.compilationError ?? null,
          revision: result.revision ?? null,
        });
      } catch (err) {
        return send(res, 500, { error: err && err.message ? err.message : String(err) });
      } finally {
        fsp.unlink(tmp).catch(() => {});
      }
    }

    if (url.pathname === '/api/editor/scene-create' && req.method === 'POST') {
      if (!session.project) return send(res, 400, { error: 'no project pinned' });
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      if (typeof body.code !== 'string' || !body.code.trim()) {
        return send(res, 400, { error: 'code required' });
      }
      const tmp = path.join(os.tmpdir(), `baz-editor-new-${Date.now().toString(36)}.tsx`);
      await fsp.writeFile(tmp, body.code, 'utf8');
      try {
        // `scenes create` has no --json — diff the project state to learn the
        // new scene's id (the only new id is the one we just made).
        const before = await bazJson(['state', '--json', '--project-id', session.project]);
        const known = new Set((before.scenes || []).map((s) => s.id));
        const args = [
          'scenes', 'create',
          '--file', tmp,
          '--duration', String(Math.max(1, Math.round(body.duration ?? 150))),
          '--track', String(body.track ?? 0),
          '--start', String(Math.max(0, Math.round(body.start ?? 0))),
          '--project-id', session.project,
        ];
        if (body.name) args.push('--name', String(body.name));
        await execFileAsync('baz', args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
        const after = await bazJson(['state', '--json', '--project-id', session.project]);
        const created = (after.scenes || []).find((s) => !known.has(s.id));
        if (!created) return send(res, 500, { error: 'create reported success but no new scene found' });
        return send(res, 200, { success: true, scene: created });
      } catch (err) {
        return send(res, 500, { error: err && err.message ? err.message : String(err) });
      } finally {
        fsp.unlink(tmp).catch(() => {});
      }
    }

    if (url.pathname === '/api/editor/scene-delete' && req.method === 'POST') {
      if (!session.project) return send(res, 400, { error: 'no project pinned' });
      const body = JSON.parse((await readBody(req, 1024 * 64)).toString('utf8'));
      if (!body.sceneId) return send(res, 400, { error: 'sceneId required' });
      try {
        await execFileAsync(
          'baz',
          ['scenes', 'delete', body.sceneId, '--force', '--project-id', session.project],
          { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }
        );
        return send(res, 200, { success: true });
      } catch (err) {
        return send(res, 500, { error: err && err.message ? err.message : String(err) });
      }
    }

    if (url.pathname === '/stream') {
      const target = url.searchParams.get('u');
      if (!target) return send(res, 400, { error: 'missing u' });
      return handleStream(req, res, target);
    }

    if (url.pathname === '/frame') {
      const p = path.resolve(url.searchParams.get('p') || '');
      // Only ever serve images we wrote — any project's frames/refs, since the
      // history a note points at may predate the current project switch.
      const allowed =
        (p.startsWith(PROJECTS_ROOT + path.sep) || p.startsWith(OUT_DIR + path.sep)) &&
        (p.includes(`${path.sep}frames${path.sep}`) || p.includes(`${path.sep}refs${path.sep}`));
      if (!allowed) return send(res, 403, { error: 'forbidden' });
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
      // Loading a different video swaps in that video's note history.
      await useProject(projectKey(session.project, session.url));
      await saveSession();
      return send(res, 200, { ...session, thumbs: args.thumbs });
    }

    if (url.pathname === '/api/voice/config' && req.method === 'GET') {
      return send(res, 200, { available: !!OPENAI_KEY, model: VOICE_MODEL });
    }

    // Debug: what the agent will hold in context. Costs nothing to look at.
    if (url.pathname === '/api/voice/digest' && req.method === 'GET') {
      const { digest } = await getProjectDigest();
      return send(res, 200, { digest });
    }

    // Client-side voice lifecycle telemetry — lands in this server's log so
    // dropped calls are diagnosable instead of "it can't hear me anymore".
    if (url.pathname === '/api/voice/log' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8'));
      console.log(`  voice-ui   ${String(body.msg || '').slice(0, 300)}`);
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/api/voice/session' && req.method === 'POST') {
      if (!OPENAI_KEY) {
        return send(res, 400, { error: 'OPENAI_API_KEY is not set — export it and restart to enable voice' });
      }
      // Digest + instructions are baked into the ephemeral session at mint
      // time, so the browser never handles the real API key or the prompt.
      const instructions = await buildVoiceInstructions();
      const mint = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model: VOICE_MODEL,
            instructions,
            tools: VOICE_TOOLS,
            audio: {
              // Explicit server VAD so barge-in actually works: the model stops
              // talking the moment you start. Without an input block the
              // defaults leave interruption unreliable — you talk over it and
              // it keeps going. Thresholds tuned for a room with speakers on:
              // a little less trigger-happy than default so its own voice
              // leaking back doesn't self-interrupt, but still cuts in fast.
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                // Transcribe what the model ACTUALLY heard. Without this there
                // is no record of the heard text, so "it answered something
                // random" is undiagnosable — you can't tell a mishearing from a
                // reasoning failure.
                transcription: { model: 'whisper-1' },
                turn_detection: {
                  type: 'semantic_vad',
                  // Semantic VAD waits for you to actually FINISH a thought
                  // instead of cutting at a fixed silence gap. A plain
                  // server_vad with a high threshold clipped the front of
                  // sentences, so the model answered fragments.
                  eagerness: 'medium',
                  interrupt_response: true,
                  create_response: true,
                },
              },
              output: { voice: 'marin' },
            },
          },
        }),
      });
      const body = await mint.json().catch(() => ({}));
      if (!mint.ok || !body.value) {
        const msg = body?.error?.message || `mint failed (HTTP ${mint.status})`;
        console.error(`  ! voice session mint failed: ${msg}`);
        return send(res, 502, { error: msg });
      }
      console.log(`  voice      session minted (${VOICE_MODEL})`);
      return send(res, 200, { token: body.value, expiresAt: body.expires_at, model: VOICE_MODEL });
    }

    if (url.pathname === '/api/voice/scene-code' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1024 * 64)).toString('utf8'));
      const want = String(body.sceneId || '').trim();
      const { blocks } = await getProjectDigest();
      // Accept an id or an exact scene name — the model sees both in the digest.
      let hit = blocks[want]
        ? { id: want, ...blocks[want] }
        : null;
      if (!hit) {
        const byName = Object.entries(blocks).find(([, b]) => b.name === want);
        if (byName) hit = { id: byName[0], ...byName[1] };
      }
      if (!hit) return send(res, 404, { error: `no scene matching "${want}"` });
      return send(res, 200, { id: hit.id, name: hit.name, code: hit.code.slice(0, 30000) });
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
  // A baz render URL names its project — adopt it so the scene map, digest and
  // note attribution all work from a bare --url. (The stale-mismatch guard has
  // already run, so this can only agree with the URL.)
  if (!session.project) {
    const pid = projectIdFor('', session.url);
    if (pid) session.project = pid;
  }
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
  console.log(`  notes      ${PROJ_DIR}${CURRENT_KEY === '_unassigned' ? '  (no video loaded yet)' : ''}`);
  console.log(`  watch      tail -n 0 -F ${LOG_FILE}`);
  if (session.url) console.log(`  video      ${session.url.slice(0, 78)}`);
  if (session.scenes.length) console.log(`  scenes     ${session.scenes.length} loaded`);
  if (session.project && syncEvery > 0) console.log(`  auto-sync  every ${syncEvery / 1000}s (newest completed export)`);
  console.log('');
  if (!args.noOpen) {
    execFile('open', [addr], () => {});
  }
});
