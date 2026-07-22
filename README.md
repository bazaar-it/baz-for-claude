# baz-for-claude

**Frame-accurate video feedback for AI coding agents.**

Reviewing generated video with an AI agent is lossy. You say *"the thing around
12 seconds feels late"*; the agent guesses. baz-for-claude replaces the guess with
coordinates: pause on a frame, type a note, and it arrives in your agent's
context as

```
[NOTE] f510 | 00:17.00 | scene "sc04c-card" 3f8b4993 +103f
       | shot /tmp/baz-for-claude/7790/frames/f00510-abc.png
       :: the glass card lands before the cursor click, pull it 6 frames later
```

— exact frame, timecode, which scene it belongs to, how far into that scene, and
a **PNG of the frame** the agent can actually open and look at.

Zero dependencies. Nothing to install.

```bash
npx baz-for-claude --url "https://your-cdn.example/render.mp4"
```

---

## How the note reaches your agent

There's no integration to configure. The server appends each note to a log file;
your agent tails it.

```
you pause + type
      │
      ▼
browser ──▶ localhost server ──▶ appends one line to notes.log
                                        │
                                        ▼
                        tail -n 0 -F …/notes.log
                                        │
                                        ▼
                          your agent's context
```

In **Claude Code**, ask it to *"watch for my video notes"* — it arms the tail
command the server prints on startup and notes stream in live. The same tail
works for any agent that can watch a file, or you can just read it yourself.

Sending doesn't touch your clipboard — the log is the delivery path. If you ever
need a note as text (nothing was watching, or you want it elsewhere), each one in
the history has a **⧉** to copy it.

The UI itself stays deliberately bare — you see a timecode, nothing else. Frame
numbers, scene ids and layer stacks are resolved server-side and ride in the
note, because that's who needs them.

## Reference images

**Paste or drop screenshots straight into the note box** — the "make it look
like *this*" case. Copy a screenshot (`⌘⌃⇧4` on macOS copies to the clipboard),
click into the composer, and paste. Drag-and-drop and the **⊕** button work too;
up to 8 images per note, removable before you send.

They're saved next to the note and their paths travel with it, flagged
`refs (READ THESE)`, so your agent opens them alongside the captured frame. That
means you can do all your prompting in the review UI instead of switching to a
chat window to attach a picture.

## Match cuts (⇄)

Park the playhead near a cut and hit **⇄**. It finds the nearest scene
boundary, grabs the **last frame of the outgoing scene and the first frame of
the incoming one**, attaches both, and offers a starting prompt in grey —
press <kbd>Tab</kbd> to accept it, or **⇄** again to cycle:

- **Motion** — carry the movement vector through the cut
- **Colour** — match luminance and palette across the splice
- **Shape** — align the key element's scale and screen position so it morphs

The suggestions name the actual scenes, and the note tells your agent which
frame is which, so it edits the tail of one scene and the head of the next to
agree. Needs `--project` (that's where the scene boundaries come from).

## Install the skill (Claude Code)

The package ships a skill that teaches Claude the whole workflow — port
selection, arming the watcher, reading the note format, and the stale-export
trap:

```bash
mkdir -p ~/.claude/skills/baz-for-claude
curl -o ~/.claude/skills/baz-for-claude/SKILL.md \
  https://raw.githubusercontent.com/bazaar-it/baz-for-claude/main/skill/SKILL.md
```

Now any Claude session in any repo knows how to run a review.

### Run it in Claude's browser

Open `http://localhost:<port>` in **Claude's own browser pane** rather than
Chrome or Safari. Review and chat stay in one window, so you're not alt-tabbing
for every note — and Claude can see the same page you can, screenshot it, and
check the console, which turns "it's not playing" from guesswork into something
it can actually diagnose. The skill tells it to do this by default.

It works in any browser — same server, same notes — you just lose those.

## Usage

```
npx baz-for-claude [options]

  --url <url>        Hosted video URL to load on start
  --project <id>     baz project id — adds scene names
  --port <n>         Port (default 7788). One session = one port.
  --fps <n>          Frames per second (default 30)
  --out <dir>        Override the state directory
  --no-thumbs        Skip frame capture (notes carry timecode only)
  --no-open          Don't auto-open the browser
  --replay           Print every past note for this port, then exit
  --sync-interval <s>  Check for a newer export every N seconds (default 30, 0 = off)
```

The URL must be **hosted** (http/https) — an S3, R2, or CDN link. Local files
aren't supported, by design: the tool is built for reviewing renders that
already live somewhere.

### Keys

| Key | Does |
|-----|------|
| `space` (or click the video) | play / pause |
| `←` `→` (or `,` `.`) | step one frame |
| `⇧` + `←` `→` | step ten frames |
| `f` | pause and jump to the feedback box |
| `↵` | send (`⇧↵` for a new line) |

Drag the playhead to scrub; click a note's timecode to jump back to that frame.

## Running several reviews at once

Each session gets its own port, so parallel agents can review different videos
with no cross-talk:

```bash
npx baz-for-claude --port 7788 --url "…/render-a.mp4"   # session A
npx baz-for-claude --port 7790 --url "…/render-b.mp4"   # session B
```

A port collision **fails loudly** (exit 2) rather than quietly binding the next
free port — a silent fallback would leave your browser tab on one server while
your notes streamed into a different session's chat.

Per session: ~50MB server + ~1MB tail + a browser tab.

## baz integration (optional)

Pass `--project <id>` and baz-for-claude calls [`baz`](https://www.npmjs.com/package/bazaar.it)
to pull the project's scene map, so notes name the scene they landed in and the
timeline shows scene boundaries.

```bash
baz export start --wait --json --project-id <id>    # get outputUrl
npx baz-for-claude --project <id> --url "<outputUrl>"
```

Given `--project`, it keeps itself current: newest completed export pulled at
startup, then re-checked every 30s in the background (`--sync-interval` to
tune, `0` to disable). When the URL changes, the open page swaps the video
within ~5s — no button, no reload. Agents can `POST /api/refresh` for an
immediate swap after re-exporting. It only ever *pulls*; it never renders, so
it never spends balance.

Without `--project`, everything else works; notes just carry frame and timecode
instead of scene names.

### The stale-export trap

Scene names come from the project's *current* timeline. Edit scenes after
exporting and every marker drifts. baz-for-claude compares the video's real duration
against the timeline total and flags a mismatch. You don't see this — the flag
rides in the note so your agent can decide whether a re-render is warranted.

Frame numbers and timecodes are **always** exact. Only scene attribution drifts.

## Why the video is proxied

The `<video>` loads through `/stream?u=…` rather than pointing at your URL
directly. That makes it same-origin, so the paused frame can be drawn to a
canvas — a cross-origin video taints the canvas and frame capture silently
fails.

Two load-bearing details:

- **Aborts propagate.** Every seek makes the browser cancel its in-flight Range
  request, and the proxy cancels the matching upstream fetch. Without it,
  scrubbing leaves a pileup of orphaned downloads holding sockets.
- **Immutable caching.** Render URLs from S3/R2 are content-unique, so responses
  are served `immutable` and your browser's own bounded cache holds them — a
  reload doesn't re-download 50MB.

Video bytes are **never written to disk** by baz-for-claude. Only the frame PNGs are
saved (~40KB each), under `<tmp>/baz-for-claude/<port>/frames/`. Use `--no-thumbs` to
skip even those.

## State

Notes belong to the **video**, not the window. Reusing a port for a different
project starts clean, and reopening a project brings its own history back —
including across a re-export, since a baz render URL carries its project id.

`<tmp>/baz-for-claude/projects/<project>/` — per video:

| File | Role |
|------|------|
| `notes.jsonl` | Data of record — one JSON object per note |
| `frames/` | Captured frame PNGs |
| `refs/` | Attached reference images |

`<tmp>/baz-for-claude/<port>/` — per window:

| File | Role |
|------|------|
| `notes.log` | Notes preformatted for `tail -F` delivery. Per port so the path your agent watches never moves, whichever project you open. |
| `session.json` | Which video this window is showing |

## Requirements

Node 18+. That's it — no dependencies.

The optional scene-map features additionally need the `baz` CLI on your PATH
(`npm i -g bazaar.it`).

## License

MIT © [baz.studio](https://baz.studio)

Not affiliated with Anthropic. "Claude" is a trademark of Anthropic, referenced
here only to describe compatibility.
