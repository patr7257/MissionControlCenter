---
name: resume-later
description: Use when Patrick wants to stop a Claude Code session on purpose but pick it up later, rather than abandoning it. Triggers include "/resume-later", "resume this later", "flag this for later", "park this session", "stopping here to save tokens", "come back to this after X", "remind me to continue this". Flags the CURRENT session so it appears under the "Resume session" button in Mission Control Center, where resuming it clears the flag.
---

# Resume later

## What this does

Flags the session you are in right now as "come back to this one". Mission Control
Center shows every flagged session behind its amber **Resume session** button, and
resuming from there reattaches the session (`claude --resume <id>`) and clears the
flag automatically.

It exists because ending a session with a clear intention to return is different
from ending one because it is finished, and the second kind should not have to be
remembered by hand. Claude Code prints `claude --resume "<name>"` when a session
ends, but that line is only useful while the terminal is still on screen.

## How to run it

One line, from inside the session being flagged (its identity comes from that
session's own environment, so it MUST run there):

```
node "C:/Users/pr/.claude/skills/agent-fleet-monitor/scripts/flag-resume.mjs"
```

With a note about why it is parked, which the picker shows:

```
node "C:/Users/pr/.claude/skills/agent-fleet-monitor/scripts/flag-resume.mjs" paused to save tokens until 16:00
```

That path is the Mission Control Center repo, reached through its skill junction,
so it stays valid while the code lives under git.

Report back what it printed (the session name it flagged and any note), and remind
Patrick that resuming from the app clears the flag by itself.

## The other modes

```
node "C:/Users/pr/.claude/skills/agent-fleet-monitor/scripts/flag-resume.mjs" --list
node "C:/Users/pr/.claude/skills/agent-fleet-monitor/scripts/flag-resume.mjs" --unflag
```

`--list` prints what is currently flagged; `--unflag` removes this session's flag
(the app's per-row **Unflag** button does the same thing). Add `--unflag <id>` to
drop a specific session, or `--id <id> --name <name>` to flag a session that is not
the one you are in.

## What it writes

One file, `~/.claude/agent-fleet-monitor/resume-flags.json`, holding
`{ sessionId, name, cwd, project, note, flaggedAt }` per flag. That file is the
whole contract with the app, so:

- Flagging works whether or not Mission Control is running. The app reads the file
  fresh on every request, so a session flagged now shows up without a restart.
- The session name comes from Claude Code's own live registry
  (`~/.claude/sessions/<pid>.json`), which is what `/rename` updates, and falls back
  to the transcript's `customTitle`. An unnamed session shows its project instead,
  and the script says so: `/rename` first if you want the picker to be obvious.
- Re-flagging the same session updates its note and timestamp rather than adding a
  duplicate.

## Notes

- Nothing is resumed by this skill. It only records the intent; the resuming
  happens from the app, deliberately, because that is where the terminal gets
  opened.
- A flagged session that later drops off the board (pruned after 7 days) is still
  offered in the picker, labelled "not on the board any more", since reattaching
  needs only the session id.
- If `CLAUDE_CODE_SESSION_ID` is somehow unset, the script fails loudly and asks
  for `--id` rather than guessing which session you meant.
