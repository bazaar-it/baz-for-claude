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

Pick a port that isn't in use. **One review session = one port**, so parallel
sessions never cross-post notes into each other's chats. A collision exits with
code 2 rather than silently binding elsewhere (that would send the user's notes
to the wrong session).

Note history belongs to the **video**, not the port: opening a different project
on a port you've used before starts clean, and reopening a project restores its
own notes. The `tail` path stays per-port, so the watcher you arm keeps working
whichever project gets loaded.

```bash
npx baz-for-claude --port 7790 --project <baz-project-id> --no-open
```

With `--project` and no `--url`, it pulls the newest completed export itself.
Pass `--url` to pin a specific video (that wins over auto-sync).

Note: `baz export list` is a *recent* window, so an older export may not be
findable — pass `--url` in that case.

### Open it in the Claude browser, not an external one

Always launch with `--no-open` (so it doesn't fire off the system browser) and
then open `http://localhost:<port>` in **Claude's own browser pane**. In Claude
Code that's `preview_start` with `{url: "http://localhost:<port>"}`.

This is the intended setup:

- **Review and chat stay in one window.** The user pauses, types a note, and
  your reply is right there — no alt-tabbing between an external browser and
  the conversation for every note.
- **You can see the same page they can.** Screenshot it, read the console,
  check the video actually loaded. In an external browser the UI is invisible
  to you, so "it's not playing" or "nothing happened" becomes guesswork.
- **You can confirm it came up** instead of telling the user to go look.

It still works in Chrome or Safari — same server, same notes — you just lose
all of the above. Don't hand the user a bare localhost URL and ask them to open
it themselves unless they've said they want it in their own browser.

## Receive the notes

The server prints a tail command on startup. Arm it with the **Monitor** tool
(persistent) and notes stream in as the user sends them:

```bash
tail -n 0 -F <tmp>/baz-for-claude/<port>/notes.log
```

Do NOT poll on a timer — the tail costs ~1MB and pushes events to you.

```
[NOTE] f510 | 00:17.00 | proj a1b2c3d4 | scene "sc04-card" 3f8b4993 +103f
       | under: sc05-typing(t0), sc00-audio(t1)
       | shot …/frames/f00510-abc.png
       | STALE EXPORT (timeline 50.80s vs video 48.92s)
       :: the glass card lands before the cursor click
```

- `f510` — absolute frame
- `+103f` — offset **within that scene**, what you need to edit its code
- `under:` — other layers at that frame, in case the note is about one of them
- `shot` — **Read this PNG.** It's exactly what the user is looking at.
- `MATCH CUT at …` — the note came from the ⇄ button at a scene boundary. The
  two images under `frames (READ BOTH …)` are, **in order**, the *last* frame of
  the outgoing scene and the *first* frame of the incoming scene. Read both
  together and compare them — the request is about the relationship between
  those two frames (shared motion vector, colour/luminance, or shape and screen
  position), so edit the **tail of the outgoing scene and the head of the
  incoming one** to agree. Both scene ids are in the line.
- `refs (READ THESE)` — reference screenshots the user attached to the note
  (pasted or dropped into the composer). These are the "make it look like
  **this**" images — an external design, a competitor's video, a mockup.
  **Always Read every ref before acting.** The note's words usually only make
  sense next to them ("match this spacing", "this style"), so acting on the
  text alone will produce the wrong change.

## The work loop — batch, fix, refresh, re-check

The user reviews faster than you edit. Notes WILL arrive while you're
mid-fix — they queue in `notes.log` and surface as background notifications.
Handling one note per export wastes renders and leaves the user waiting, and
finishing a fix without checking the queue means ignoring feedback they
already sent. The loop is:

1. **Drain the queue first.** Before starting work, read every pending note:
   `tail -20 <tmp>/baz-for-claude/<port>/notes.log` (or `--replay` for all).
   New notifications that arrive mid-turn are part of the same batch.
2. **Fix the whole batch — in parallel when the notes touch different scenes.**
   Group the notes by scene id. If your agent can spawn subagents (Claude Code:
   the Task/Agent tool), fan out **one subagent per scene** and let them edit
   concurrently — a 6-note batch across 6 scenes finishes in roughly the time
   of one. Rules that keep parallel edits safe:
   - **One subagent per scene, never per note.** Two notes on the same scene go
     to the *same* subagent — two agents editing one scene's code clobber each
     other.
   - **Every baz command pins `--project-id <id>`.** Concurrent sessions flip
     the active-project pointer, so an unpinned command can edit the wrong
     project. Each subagent uses `baz scenes code <scene-id> --project-id <id>`
     to read and `baz scenes set-code <scene-id> --file f.tsx --project-id <id>`
     to write (scene id is positional), always pinned.
   - **Keep structural changes serial and in the main agent** — reordering,
     retiming that shifts neighbors, or add/delete that renumbers scenes touches
     shared project state and must not run alongside per-scene edits. Do the
     parallel per-scene code edits first, then any structural pass, then export.
   - **Do NOT export inside a subagent.** Export is the join point (step 3):
     one export after every subagent has returned.
3. **Export ONCE** after all edits land (`baz export start --wait --json --project-id <id>`),
   then **refresh:** `curl -sX POST http://localhost:<port>/api/refresh` — the
   open page swaps to the new render within ~5s. The server also auto-checks
   every 30s, so a forgotten refresh self-heals — but POST anyway; the user
   shouldn't wait half a minute.
4. **Re-check the queue before reporting done.** If notes arrived while you
   were editing or exporting, go to 2. Only tell the user you're finished when
   the queue is empty.

The page never swaps the video while the user is mid-note, so refreshing is
always safe.

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

That replays the notes for whichever project that port is currently showing.
Pass `--project <id>` to replay a specific one.

## Acting on a note

1. `Read` the `shot` PNG — see the actual problem — plus every `refs` image the
   note carries.
2. Use the scene id to fetch code (`baz scenes code <id> --output f.tsx --project-id <id>`).
3. Convert `+Nf` to the scene's local frame when editing timings.
4. Fix the batch, export once, `POST /api/refresh`, re-check the queue —
   don't make the user reload anything or repeat themselves.
