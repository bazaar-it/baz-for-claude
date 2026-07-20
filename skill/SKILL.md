---
name: bazframe
description: Frame-accurate video feedback. Launch a local review UI for a hosted video so the user can pause on a frame and send notes that arrive in this session with the exact frame number, timecode, scene id, and a PNG of that frame. Use when the user wants to review, critique, or give feedback on a rendered video, or says "let me review this video", "watch for my video notes", or shares a video export URL to iterate on.
---

# bazframe — frame-accurate video feedback

Reviewing video over chat is lossy. "Fix the bit around 12 seconds" is ambiguous;
"frame 373, scene 4, +42f" is actionable. bazframe closes that gap: the user
pauses on a frame, types a note, and it arrives here with exact coordinates and
a still you can actually look at.

## Start a session

Pick a port that isn't in use. **One review session = one port** — state is
isolated per port, so parallel sessions never cross-post notes into each
other's chats.

```bash
npx bazframe --port 7790 --url "<hosted-video-url>" --no-open
```

Add `--project <id>` when the video is a [baz](https://www.npmjs.com/package/bazaar.it)
export — it pulls the scene map via `baz review --json` so every note names the
scene it landed in.

The URL must be **hosted** (S3/R2/any http(s)), not a local file. For baz:

```bash
baz export start --wait --json --project-id <id>   # returns outputUrl
```

If the port is taken the server exits with code 2 and tells you — pick another.
It deliberately does not auto-increment, because silently binding a different
port sends the user's notes to the wrong session.

## Receive the notes

The server prints a tail command on startup. Arm it with the **Monitor** tool
(persistent), and every note the user sends streams into this session:

```bash
tail -n 0 -F <tmp>/bazframe/<port>/notes.log
```

Do NOT poll the file on a timer — the tail costs ~1MB and pushes events to you.

Each note is one line:

```
[NOTE] f510 | 00:17.00 | proj 4d649aa5 | scene "sc04c-card" 3f8b4993 +103f
       | under: sc05-typing(t0), sc00-audio(t1)
       | shot /tmp/bazframe/7790/frames/f00510-abc.png :: the card lands too early
```

- `f510` — absolute frame in the video
- `+103f` — offset **within that scene**, which is what you need to edit its code
- `under:` — other layers live at that frame, in case the note is about one of them
- `shot` — **Read this PNG.** It shows exactly what the user is looking at.

## Catching up in a fresh session

Notes are always written to disk, even when nothing is watching. If you join a
session late, or the user says "check my video notes":

```bash
npx bazframe --port 7790 --replay
```

That re-prints every note for that port and exits.

## The stale-export trap

Scene names come from the project's **current** timeline. If the user edits
scenes after exporting, the video no longer matches and every scene name drifts.

bazframe compares the video's real duration against the timeline total and flags
the mismatch — the UI shows a **⚠ stale — pull latest** button and notes carry
`STALE EXPORT`. When you see that flag:

- **Trust** the frame number and timecode. They're always exact.
- **Distrust** the scene name and `+Nf` offset.
- Tell the user to click *pull latest* (swaps in the newest completed export,
  costs nothing) or to re-export if that isn't enough.

Never act on a scene id from a note flagged `STALE EXPORT` without re-checking.

## Acting on a note

1. `Read` the `shot` PNG — see the actual problem.
2. Use the scene id to fetch the code (`baz scenes code <id> --output f.tsx`).
3. Convert `+Nf` to the scene's local frame number when editing timings.
4. Fix, re-export, and let the user review the new URL — click *pull latest* in
   the UI rather than restarting the server.
