# Troubleshooting agent-fleet-monitor

## The page loads but no agents appear

1. Confirm the hooks are installed. Open `~/.claude/settings.json` and look for a `hooks`
   block containing `agent-fleet-monitor/send-event.mjs` under `SubagentStart`, `PreToolUse`,
   etc. If missing, run `node "<skill>/start.mjs"` again.
2. Hooks are read at session start. If you installed them mid-session, **start a new Claude
   Code session** (or run the next prompt) so the new hooks load.
3. Make sure you are actually spawning subagents. Only subagent activity (events with an
   `agent_id`) populates the board; plain main-session tool calls do not.

## The server will not start

- Port already in use: start with another port, e.g.
  `node "<skill>/start.mjs" --port 4318`, then open `http://localhost:4318`.
- Check the lock file at `~/.claude/agent-fleet-monitor/server.lock`. If it points at a dead
  PID, delete it and run `start.mjs` again.
- Run the server in the foreground to see errors:
  `node "<skill>/server.mjs"` then open the printed URL.

## Tokens show as steps

While a subagent runs, the card shows step count (tool calls) and elapsed time. Token totals
are read from the subagent transcript when it finishes, so they appear on the Done card.

## Removing the hooks by hand

Run `node "<skill>/stop.mjs"`. It removes only the entries whose command contains
`agent-fleet-monitor/send-event.mjs` and leaves all other settings intact. A pre-install
backup is at `~/.claude/settings.json.fleet-monitor.bak`.

## Windows / PowerShell notes

- Node must be on PATH (the hook command calls `node`). Verify with `node --version`.
- Paths in the hook command use forward slashes; node accepts these on Windows.
- The launcher opens the browser with `cmd /c start`. If it does not open, just visit
  `http://localhost:4317` manually.

## Verify the event pipeline quickly

With the server running, post a fake event and watch it appear:

```
node -e "const h=require('http');const d=Buffer.from(JSON.stringify({hook_event_name:'SubagentStart',agent_id:'demo1',agent_type:'Explore'}));const r=h.request({host:'127.0.0.1',port:4317,path:'/event',method:'POST',headers:{'Content-Type':'application/json','Content-Length':d.length}},x=>x.on('data',()=>{}).on('end',()=>process.exit(0)));r.write(d);r.end();"
```

## Office view shows nothing or looks flat

- The Office view needs the static assets to load. Confirm `/style.css`, `/store.js`,
  `/view-cards.js`, `/view-office.js` all return 200 (the server serves everything under
  public/). Hard refresh (Ctrl+Shift+R) to bypass cache after an update.
- Characters only appear for subagent activity (events with an agent_id), same as the cards.
- If the floor looks crowded with many agents, that is expected: the floor scales down to fit;
  resize the window or reduce concurrent agents.
- Switching between Pro and Office is instant and loss-free; both render from the same data.
