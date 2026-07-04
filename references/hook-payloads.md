# Hook payloads used by agent-fleet-monitor

Source: Claude Code hooks reference (https://code.claude.com/docs/en/hooks).
All hooks share a common envelope and add event-specific fields.

## Common fields (every hook)

```json
{
  "session_id": "...",
  "prompt_id": "...",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/working/dir",
  "permission_mode": "default",
  "hook_event_name": "EventName",
  "agent_id": "subagent-id-if-applicable",
  "agent_type": "agent-name-if-applicable"
}
```

## Events we feed (configured in ~/.claude/settings.json)

| Event | Matcher | What we read | Card effect |
| --- | --- | --- | --- |
| `SubagentStart` | `*` (agent type) | `agent_id`, `agent_type`, `transcript_path` | create the card; read the task from the transcript's first user message |
| `PreToolUse` | `*` (tool name) | `agent_id`, `tool_name` | set "now: <tool>" and mark the card busy |
| `PostToolUse` | `*` | `agent_id`, `tool_name` | increment steps, mark idle, set "last: <tool>" |
| `SubagentStop` | `*` | `agent_id`, `transcript_path` | move to Done; read output tokens from the transcript |
| `Stop` | (none) | n/a | logged only in v1 |
| `Notification` | (none) | n/a | logged only in v1 |

## Why we read the task from the transcript

`SubagentStart` carries `agent_id` + `agent_type` but not the task text. `PreToolUse` on the
spawn tool carries the task text but not the `agent_id`. Rather than correlate the two
(fragile when several agents of the same type spawn together), the server reads the
subagent's own transcript at `transcript_path` and takes its first user message, which is the
task prompt. The file may not be flushed at `SubagentStart` time, so the server retries a few
times and re-broadcasts when the task resolves. If it never resolves, the card falls back to
showing the agent type.

## Key fact: tool hooks inside a subagent carry `agent_id`

`PreToolUse` / `PostToolUse` fired while a subagent is running include that subagent's
`agent_id`, which is how we attribute "current tool" and step counts to the right card.
Main-session tool calls (no `agent_id`) are ignored for the board.

## Hook entry shape we write

```json
{
  "type": "command",
  "command": "node \"C:/Users/.../agent-fleet-monitor/send-event.mjs\"",
  "async": true,
  "timeout": 10
}
```

`async: true` means the hook never blocks the turn. The shim short-circuits instantly if the
server lock file is absent and always exits 0.
