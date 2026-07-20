---
name: baz-for-claude
description: Frame-accurate video feedback. Launch a local review UI for a hosted video so the user can pause on a frame and send notes that arrive in this session with the exact frame number, timecode, scene id, and a PNG of that frame. Use when the user wants to review, critique, or give feedback on a rendered video, or says "let me review this video", "watch for my video notes", or shares a video export URL to iterate on.
---

# baz-for-claude — frame-accurate video feedback

Reviewing video over chat is lossy. "Fix the bit around 12 seconds" is ambiguous;
"frame 510, scene sc04c-card, +103f" is actionable. This closes that gap: the
user pauses on a frame, types a note, and it arrives here with exact coordinates
and a still you can open.

**The UI is deliberately minimal — the user only sees a timecode.** Frame
numbers, scene ids, layer stacks and staleness are resolved server-side and
travel in the note. Don't ask the user for any of it; it's already in your hands.

## Start a session

Pick a port that isn't in use. **One review session = one port** — state is
isolated per port, so parallel sessions never cross-post notes into each
other's chats. A collision exits with code 2 rather than silently binding
elsewhere (that would send the user's notes to the wrong session).

```bash
npx baz-for-claude --port 7790 --project <baz-project-id> --no-open
```

With `--project` and no `--url`, it pulls the newest completed export itself.
Pass `--url` to pin a specific video (that wins over auto-sync).

Note: `baz export list` is a *recent* window, so an older export may not be
findable — pass `--url` in that case.

## Receive the notes

The server prints a tail command on startup. Arm it with the **Monitor** tool
(persistent) and notes stream in as the user sends them:

```bash
tail -n 0 -F <tmp>/baz-for-claude/<port>/notes.log
```

Do NOT poll on a timer — the tail costs ~1MB and pushes events to you.

```
[NOTE] f510 | 00:17.00 | proj 4d649aa5 | scene "sc04c-card" 3b67a67f +103f
       | under: sc05-typing(t0), sc00-audio(t1)
       | shot …/frames/f00510-abc.png
       | STALE EXPORT (timeline 50.80s vs video 48.92s)
       :: the glass card lands before the cursor click
```

- `f510` — absolute frame
- `+103f` — offset **within that scene**, what you need to edit its code
- `under:` — other layers at that frame, in case the note is about one of them
- `shot` — **Read this PNG.** It's exactly what the user is looking at.

## Keeping the video current — your job, not theirs

There is no refresh button in the UI. When you re-export, tell the server and
the user's page swaps itself within ~5s:

```bash
curl -sX POST http://localhost:<port>/api/refresh
```

The page polls for URL changes (cheap, local) and reloads the video
automatically — but never while the user is mid-note, so their subject doesn't
vanish as they're describing it.

## STALE EXPORT

When a note carries this flag, the video predates the project's current
timeline, so scene attribution has drifted:

- **Trust** the frame number and timecode. Always exact.
- **Distrust** the scene name and `+Nf` offset.
- `POST /api/refresh` first — it pulls the newest existing export for free.
- If the flag persists, the newest export still predates the edits. Only a
  re-render fixes it (`baz export start --wait --json`), which costs money and
  minutes — so decide deliberately and say so, rather than doing it silently.

Never act on a scene id from a `STALE EXPORT` note without re-checking.

## Catching up

Notes are written to disk even when nothing is watching. Joining late, or the
user says "check my video notes":

```bash
npx baz-for-claude --port 7790 --replay
```

## Acting on a note

1. `Read` the `shot` PNG — see the actual problem.
2. Use the scene id to fetch code (`baz scenes code <id> --output f.tsx`).
3. Convert `+Nf` to the scene's local frame when editing timings.
4. Fix, re-export, `POST /api/refresh` — don't make them reload anything.
