# bazframe

**Frame-accurate video feedback for AI coding agents.**

Reviewing generated video with an AI agent is lossy. You say *"the thing around
12 seconds feels late"*; the agent guesses. bazframe replaces the guess with
coordinates: pause on a frame, type a note, and it arrives in your agent's
context as

```
[NOTE] f510 | 00:17.00 | scene "sc04c-card" 3f8b4993 +103f
       | shot /tmp/bazframe/7790/frames/f00510-abc.png
       :: the glass card lands before the cursor click, pull it 6 frames later
```

— exact frame, timecode, which scene it belongs to, how far into that scene, and
a **PNG of the frame** the agent can actually open and look at.

Zero dependencies. Nothing to install.

```bash
npx bazframe --url "https://your-cdn.example/render.mp4"
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

Every note is also copied to your clipboard when you send it, so you can paste
it manually if nothing is listening.

## Install the skill (Claude Code)

The package ships a skill that teaches Claude the whole workflow — port
selection, arming the watcher, reading the note format, and the stale-export
trap:

```bash
mkdir -p ~/.claude/skills/bazframe
curl -o ~/.claude/skills/bazframe/SKILL.md \
  https://raw.githubusercontent.com/bazaar-it/bazframe/main/skill/SKILL.md
```

Now any Claude session in any repo knows how to run a review.

## Usage

```
npx bazframe [options]

  --url <url>        Hosted video URL to load on start
  --project <id>     baz project id — adds scene names
  --port <n>         Port (default 7788). One session = one port.
  --fps <n>          Frames per second (default 30)
  --out <dir>        Override the state directory
  --no-thumbs        Skip frame capture (notes carry timecode only)
  --no-open          Don't auto-open the browser
  --replay           Print every past note for this port, then exit
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
| `⌘↵` | send |

Drag the playhead to scrub; click a note's timecode to jump back to that frame.

## Running several reviews at once

State is isolated **per port** (`<tmp>/bazframe/<port>/`), so parallel agent
sessions can each review a different video with no cross-talk:

```bash
npx bazframe --port 7788 --url "…/render-a.mp4"   # session A
npx bazframe --port 7790 --url "…/render-b.mp4"   # session B
```

A port collision **fails loudly** (exit 2) rather than quietly binding the next
free port — a silent fallback would leave your browser tab on one server while
your notes streamed into a different session's chat.

Per session: ~50MB server + ~1MB tail + a browser tab.

## baz integration (optional)

Pass `--project <id>` and bazframe calls [`baz`](https://www.npmjs.com/package/bazaar.it)
to pull the project's scene map, so notes name the scene they landed in and the
timeline shows scene boundaries.

```bash
baz export start --wait --json --project-id <id>    # get outputUrl
npx bazframe --project <id> --url "<outputUrl>"
```

The **⚠ stale — pull latest** button fetches the newest completed export for the
project. It only ever *pulls* — it never renders, so it never spends balance.

Without `--project`, everything else works; notes just carry frame and timecode
instead of scene names.

### The stale-export trap

Scene names come from the project's *current* timeline. Edit scenes after
exporting and every marker drifts. bazframe compares the video's real duration
against the timeline total and flags a mismatch — the UI shows the warning and
notes carry a `sceneMapStale` flag.

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

Video bytes are **never written to disk** by bazframe. Only the frame PNGs are
saved (~40KB each), under `<tmp>/bazframe/<port>/frames/`. Use `--no-thumbs` to
skip even those.

## State

`<tmp>/bazframe/<port>/`

| File | Role |
|------|------|
| `notes.jsonl` | Data of record — one JSON object per note |
| `notes.log` | Same notes preformatted for `tail -F` delivery |
| `frames/` | Captured frame PNGs |
| `session.json` | URL + project id + scene map, survives restarts |

## Requirements

Node 18+. That's it — no dependencies.

The optional scene-map features additionally need the `baz` CLI on your PATH
(`npm i -g bazaar.it`).

## License

MIT © [baz.studio](https://baz.studio)

Not affiliated with Anthropic. "Claude" is a trademark of Anthropic, referenced
here only to describe compatibility.
