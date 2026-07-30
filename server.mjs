// agent-fleet-monitor server
// Zero-dependency local server: only Node built-ins (http, fs, path, os, url).
// - GET  /         serves the dashboard (public/index.html)
// - GET  /stream   Server-Sent Events stream (live push to the browser)
// - POST /event    receives a Claude Code hook payload, updates the fleet model,
//                  and broadcasts the change to all connected browsers
//
// State lives in memory and is keyed by agent_id. We never depend on a database
// or any npm package, so this runs anywhere Node runs with no install step.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as terminal from './terminal.mjs';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(SKILL_DIR, 'public');
const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.claude', 'agent-fleet-monitor');
const LOCK_FILE = path.join(DATA_DIR, 'server.lock');
const LOG_FILE = path.join(DATA_DIR, 'log.jsonl');
// Sessions model is persisted here so a server restart (dev reload, machine
// reboot) does not lose the board. Rehydrated on start and merged with the
// backfill scan; writes are debounced and skipped under CMC_DRY_RUN.
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
// Global usage (5h/7d rate-limit windows) persisted alongside the sessions
// file; see the `usage` module-level state below.
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
// Persisted sessions older than this (by lastActivityAt) are dropped on load so
// the file cannot grow without bound. Ended sessions used to get a shorter
// (24h) horizon, but that hid yesterday's closed-but-resumable sessions from
// the board, so they now share the same 7-day window as everything else. A
// hard count cap backs both up.
const SESSIONS_PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7d
const SESSIONS_ENDED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7d (raised from 24h)
const SESSIONS_MAX_PERSISTED = 200;

// Port: default 4317, override with --port <n>
function readPortArg() {
  const i = process.argv.indexOf('--port');
  if (i !== -1 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10);
    if (!Number.isNaN(n)) return n;
  }
  return 4317;
}
const PORT = readPortArg();

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Fleet model
// ---------------------------------------------------------------------------
// agents: Map<agent_id, agent>
//   agent = { id, type, task, status, busy, currentTool, lastTool,
//             steps, tokens, startedAt, endedAt, parentSession }
const agents = new Map();
// sessions: Map<session_id, session>
//   session = { id, cwd, project, branch, model, status, title, lastPrompt,
//               startedAt, lastActivityAt, live, source }
// (subagentCount is computed at serialize time from `agents`, not stored here.)
const sessions = new Map();
const sseClients = new Set();
let firstSeenAt = null;

// Account-wide 5h/7d rate-limit usage, fed by the statusLine wrapper
// (POST /statusline). Not tied to any one session, since Claude's rate limits
// are per-account, not per-session. Shape: { fiveHour: {pct, resetsAt}|null,
// sevenDay: {pct, resetsAt}|null, at }, or null before we ever hear from it.
let usage = null;

function nowMs() {
  return Date.now();
}

function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      // a dead client is cleaned up on its own 'close' handler
    }
  }
}

function pushAgent(agent) {
  broadcast({ type: 'agent', agent });
}

// Number of subagents currently attributed to a given parent session.
function countSubagents(sessionId) {
  let n = 0;
  for (const a of agents.values()) {
    if (a.parentSession === sessionId) n += 1;
  }
  return n;
}

// Strip internal-only fields and compute derived ones for the wire format.
function serializeSession(s) {
  return {
    id: s.id,
    cwd: s.cwd,
    project: s.project,
    branch: s.branch,
    model: s.model,
    status: s.status,
    title: s.title,
    lastPrompt: s.lastPrompt,
    startedAt: s.startedAt,
    lastActivityAt: s.lastActivityAt,
    live: s.live,
    subagentCount: countSubagents(s.id),
    source: s.source,
    // Fed by the statusLine wrapper (POST /statusline); null until it fires.
    modelDisplay: s.modelDisplay != null ? s.modelDisplay : null,
    ctxPct: s.ctxPct != null ? s.ctxPct : null,
    ctxTokens: s.ctxTokens != null ? s.ctxTokens : null,
    ctxSize: s.ctxSize != null ? s.ctxSize : null,
    usageAt: s.usageAt != null ? s.usageAt : null,
  };
}

function pushSession(s) {
  broadcast({ type: 'session', session: serializeSession(s) });
  scheduleSaveSessions();
}

function snapshotPayload() {
  return {
    type: 'snapshot',
    firstSeenAt,
    agents: Array.from(agents.values()),
    sessions: Array.from(sessions.values()).map(serializeSession),
    usage,
  };
}

// ---------------------------------------------------------------------------
// Transcript helpers (best effort, never throw)
// ---------------------------------------------------------------------------
function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (typeof c === 'string') parts.push(c);
      else if (c && typeof c.text === 'string') parts.push(c.text);
    }
    return parts.join(' ');
  }
  return '';
}

// First user message of a subagent transcript is its task prompt.
function readTaskFromTranscript(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (obj && obj.type === 'user' && obj.message) {
        const text = extractTextFromContent(obj.message.content).trim();
        if (text) return text;
      }
    }
  } catch {
    // ignore: fall back to agent type
  }
  return null;
}

// Sum of output tokens across assistant messages (the "down" figure, like FleetView).
function readTokensFromTranscript(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');
    let out = 0;
    let found = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const usage = obj && obj.message && obj.message.usage;
      if (usage && typeof usage.output_tokens === 'number') {
        out += usage.output_tokens;
        found = true;
      }
    }
    return found ? out : null;
  } catch {
    return null;
  }
}

function cleanTask(text, fallback) {
  if (!text) return fallback;
  let t = text.replace(/\s+/g, ' ').trim();
  // Strip a leading system-reminder block if present.
  t = t.replace(/^<system-reminder>[\s\S]*?<\/system-reminder>\s*/i, '').trim();
  if (t.length > 240) t = t.slice(0, 237) + '...';
  return t || fallback;
}

// A session's lastPrompt is shown as a one-line summary in the UI, so it gets
// a tighter cap than the 240-char cleanTask() limit used for subagent tasks.
function truncateLastPrompt(text) {
  if (!text) return text;
  if (text.length > 100) return text.slice(0, 97) + '...';
  return text;
}

// Try to attach the human-readable task. The transcript may not be flushed at
// SubagentStart time, so retry a couple of times and re-broadcast when found.
function attachTaskLater(agentId, transcriptPath) {
  const delays = [250, 1000, 3000];
  delays.forEach((d) => {
    setTimeout(() => {
      const agent = agents.get(agentId);
      if (!agent || agent._taskResolved) return;
      const task = readTaskFromTranscript(transcriptPath);
      if (task) {
        agent.task = cleanTask(task, agent.type);
        agent._taskResolved = true;
        pushAgent(agent);
      }
    }, d);
  });
}

// The cwd and gitBranch fields live in the SessionStart preamble at the top of
// a transcript, so a single bounded head-read is enough for both. This avoids
// a full-file readFileSync (transcripts can be 15+ MB) on every call site.
function readSessionMetaFromTranscript(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return {};
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    const lines = buf.toString('utf8', 0, n).split('\n');
    let cwd = null;
    let branch = null;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let o;
      try {
        o = JSON.parse(t);
      } catch {
        continue;
      }
      if (!cwd && o && o.cwd) cwd = o.cwd;
      if (!branch && o && o.gitBranch) branch = o.gitBranch;
      if (cwd && branch) break;
    }
    return { cwd, branch };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Session model
// ---------------------------------------------------------------------------
function projectNameFromCwd(cwd) {
  if (!cwd) return null;
  try {
    return path.basename(cwd.replace(/[\\/]+$/, ''));
  } catch {
    return null;
  }
}

// A session launched from the New session bar with a name was started as
// `claude --name <name>`, but the session id only exists once its first hook
// fires. terminal.bindSession() joins the two (by cwd, inside its bind window)
// and hands the name back here, which is when the session finally gets its
// label. Never overwrites a name already set.
function applyLaunchName(session, launchName) {
  if (!session || session.title) return;
  const name = typeof launchName === 'string' ? launchName.trim() : '';
  if (name) session.title = name;
}

// Create a session with defaults if missing, without downgrading anything
// already tracked. Returns the (possibly existing) session object.
function ensureSession(id, cwd, transcriptPath) {
  if (!id) return null;
  let session = sessions.get(id);
  if (!session) {
    const meta = readSessionMetaFromTranscript(transcriptPath);
    session = {
      id,
      cwd: cwd || meta.cwd || null,
      project: projectNameFromCwd(cwd || meta.cwd),
      branch: meta.branch,
      model: null,
      status: 'working',
      title: null,
      lastPrompt: null,
      startedAt: nowMs(),
      lastActivityAt: nowMs(),
      live: true,
      source: 'hook',
      transcript: transcriptPath || null,
      // Fed by the statusLine wrapper (POST /statusline); see serializeSession.
      modelDisplay: null,
      ctxPct: null,
      ctxTokens: null,
      ctxSize: null,
      usageAt: null,
      // Internal only, never serialized (see serializeSession): true once this
      // session has seen a top-level hook (SessionStart/UserPromptSubmit). Until
      // then its status is derived from its subagents instead of sitting on the
      // 'working' default forever (a session created only from subagent events
      // never otherwise gets a hook that would move it off 'working').
      sawTopLevel: false,
    };
    sessions.set(id, session);
  }
  return session;
}

// ---------------------------------------------------------------------------
// Session persistence (best effort, never throws)
// ---------------------------------------------------------------------------
// Debounced write of the whole sessions map. Coalesces the bursty mutations of
// a single turn into one disk write. Skipped entirely under CMC_DRY_RUN so test
// runs never touch the real persisted state.
let saveSessionsTimer = null;
function scheduleSaveSessions() {
  if (process.env.CMC_DRY_RUN) return;
  if (saveSessionsTimer) return;
  saveSessionsTimer = setTimeout(() => {
    saveSessionsTimer = null;
    saveSessionsNow();
  }, 1000);
}

function saveSessionsNow() {
  if (process.env.CMC_DRY_RUN) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Newest first, then cap: an unbounded map would grow the file forever. The
    // full internal session objects (including transcript/source) are persisted;
    // serializeSession is only for the wire format.
    const arr = Array.from(sessions.values()).sort(
      (a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)
    );
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(arr.slice(0, SESSIONS_MAX_PERSISTED)));
    // Global usage is small and always-current, so it rides the same debounced
    // write as the sessions file rather than getting its own timer.
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch {
    // best effort only
  }
}

// Shared by loadPersistedSessions() below and reconcileSessionRegistry()
// (see the statusline/registry section further down): a session with nothing
// left proving it is still live (not seen this run, or its registry file
// just disappeared) degrades one notch to 'recent' rather than jumping
// straight to 'ended', which only a real SessionEnd hook may set. A session
// that is not in-flight (already 'recent', 'ended', or 'done') is untouched.
function downgradeToRecentIfInFlight(session) {
  if (session.status === 'working' || session.status === 'awaiting' || session.status === 'needs-permission') {
    session.status = 'recent';
  }
}

// Rehydrate persisted sessions on start, before the backfill scan (which skips
// any id already present) and before hooks fire (which upgrade them again). Old
// and long-ended sessions are pruned here so the file self-trims over time.
function loadPersistedSessions() {
  if (process.env.CMC_DRY_RUN) return;
  try {
    const arr = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (!Array.isArray(arr)) return;
    const now = nowMs();
    for (const s of arr) {
      if (!s || !s.id || sessions.has(s.id)) continue;
      const age = now - (s.lastActivityAt || 0);
      if (age > SESSIONS_PERSIST_MAX_AGE_MS) continue;
      if (s.status === 'ended' && age > SESSIONS_ENDED_MAX_AGE_MS) continue;
      // This session was not seen live this run: it is not connected until a hook
      // says otherwise, and any in-flight status would be a stale spinner, so
      // downgrade it to 'recent'. Live hooks re-upgrade it on the next event.
      s.live = false;
      downgradeToRecentIfInFlight(s);
      sessions.set(s.id, s);
    }
  } catch {
    // no persisted state yet, or unreadable: start fresh
  }
}

// Rehydrate the last-known global usage on start, so a restart shows the last
// real numbers instead of blank until the next statusline invocation. Best
// effort; a missing or unreadable file just leaves `usage` at its null default.
function loadPersistedUsage() {
  if (process.env.CMC_DRY_RUN) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (parsed && (parsed.fiveHour || parsed.sevenDay)) usage = parsed;
  } catch {
    // no persisted usage yet, or unreadable: start fresh
  }
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------
function ensureAgent(id, type, session) {
  let agent = agents.get(id);
  if (!agent) {
    agent = {
      id,
      type: type || 'agent',
      task: type || 'agent',
      status: 'working',
      busy: false,
      currentTool: null,
      lastTool: null,
      steps: 0,
      tokens: null,
      startedAt: nowMs(),
      endedAt: null,
      parentSession: session || null,
      _taskResolved: false,
    };
    agents.set(id, agent);
    if (!firstSeenAt) firstSeenAt = agent.startedAt;
  }
  return agent;
}

// A session with no top-level hook yet (see sawTopLevel) has no Stop/
// Notification of its own to derive status from, so instead derive it from
// its subagents: 'working' while any child is active, 'awaiting' otherwise.
// Returns true if the status changed, so the caller only pushes an update
// when something actually moved. Sessions that HAVE seen a top-level signal
// are never touched here; their status stays exactly hook-derived.
function deriveSubagentOnlyStatus(session) {
  let anyActive = false;
  for (const agent of agents.values()) {
    if (agent.parentSession !== session.id) continue;
    if (agent.status === 'working' || agent.busy) {
      anyActive = true;
      break;
    }
  }
  const next = anyActive ? 'working' : 'awaiting';
  if (session.status === next) return false;
  session.status = next;
  return true;
}

// Main-session tool calls (no agent_id) used to be dropped on the floor
// entirely (see the old `if (!agentId) return` in PreToolUse/PostToolUse
// below), so once a permission prompt was approved the session sat on
// 'needs-permission' (or 'awaiting') for the rest of the turn: PreToolUse and
// PostToolUse fire per tool call, but the only hooks that used to clear a
// blocked status were Stop (whole turn done) or UserPromptSubmit (the next
// prompt), which can be minutes away on a long tool-heavy turn. This proves
// the session is unblocked the moment its own tool activity resumes.
//
// Fires on every tool call, so this must not flood the SSE stream: the
// status transition itself (session actually was blocked) is immediate and
// always returns true, but once the session is already 'working' a pure
// activity refresh is throttled to at most once every
// MAIN_SESSION_ACTIVITY_BROADCAST_MS. Same true/false-means-broadcast
// contract as deriveSubagentOnlyStatus above, so the caller only pushSession
// when this returns true.
const MAIN_SESSION_ACTIVITY_BROADCAST_MS = 4000;
function unblockMainSessionOnToolActivity(session) {
  if (!session) return false;
  if (session.status === 'awaiting' || session.status === 'needs-permission') {
    session.status = 'working';
    return true;
  }
  const now = nowMs();
  if (!session._lastToolActivityBroadcastAt || now - session._lastToolActivityBroadcastAt >= MAIN_SESSION_ACTIVITY_BROADCAST_MS) {
    session._lastToolActivityBroadcastAt = now;
    return true;
  }
  return false;
}

function handleEvent(payload) {
  const ev = payload && payload.hook_event_name;
  const agentId = payload && payload.agent_id;
  const agentType = payload && payload.agent_type;
  const tool = payload && payload.tool_name;
  const transcript = payload && payload.transcript_path;
  const sessionId = payload && payload.session_id;
  const cwd = payload && payload.cwd;

  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ at: nowMs(), payload }) + '\n');
  } catch {
    // logging is best effort
  }

  // Session-lifecycle events carry session_id but no agent_id. Handle them
  // before the agent_id guards below, which are for subagent events only.
  switch (ev) {
    case 'SessionStart': {
      if (!sessionId) return;
      const isNew = !sessions.has(sessionId);
      const session = ensureSession(sessionId, cwd, transcript);
      session.cwd = cwd || session.cwd;
      session.project = projectNameFromCwd(session.cwd) || session.project;
      session.model = payload.model || session.model;
      if (!isNew) {
        // ensureSession() already read meta for a brand-new session; only
        // re-read here if the session pre-existed (e.g. hook fired again).
        const meta = readSessionMetaFromTranscript(transcript);
        session.branch = meta.branch || session.branch;
      }
      session.status = 'working';
      session.live = true;
      session.source = 'hook';
      session.lastActivityAt = nowMs();
      session.sawTopLevel = true;
      try {
        applyLaunchName(session, terminal.bindSession(session.cwd, sessionId));
      } catch {
        // best effort only, never let binding affect session tracking
      }
      // Claude Code sends session_title on SessionStart for ANY named session
      // (claude --name), not just ones launched from Mission Control, which
      // is why this runs in addition to (and after) the bindSession-derived
      // name above: applyLaunchName no-ops once a title is already set, so
      // the Mission Control launch name (if any) still wins ties.
      if (payload.session_title) applyLaunchName(session, payload.session_title);
      pushSession(session);
      return;
    }
    case 'UserPromptSubmit': {
      if (!sessionId) return;
      const session = ensureSession(sessionId, cwd, transcript);
      session.status = 'working';
      session.lastActivityAt = nowMs();
      session.sawTopLevel = true;
      const promptText = payload.prompt || payload.message;
      if (promptText) session.lastPrompt = truncateLastPrompt(cleanTask(promptText, session.lastPrompt));
      // Bind retry: the SessionStart bind may have missed (server restarted
      // between launch and hook, tab not yet up, etc). This is idempotent and
      // only ever matches an unbound tab, so it is safe to call on every prompt.
      try {
        applyLaunchName(session, terminal.bindSession(session.cwd, sessionId));
      } catch {
        // best effort only, never let binding affect session tracking
      }
      pushSession(session);
      return;
    }
    case 'Stop': {
      if (!sessionId) return;
      const session = ensureSession(sessionId, cwd, transcript);
      session.status = 'awaiting';
      session.lastActivityAt = nowMs();
      pushSession(session);
      return;
    }
    case 'Notification': {
      if (!sessionId) return;
      const session = ensureSession(sessionId, cwd, transcript);
      if (payload.notification_type === 'permission_prompt') session.status = 'needs-permission';
      else if (payload.notification_type === 'idle_prompt') session.status = 'awaiting';
      session.lastActivityAt = nowMs();
      pushSession(session);
      return;
    }
    case 'SessionEnd': {
      if (!sessionId) return;
      const session = ensureSession(sessionId, cwd, transcript);
      session.status = 'ended';
      session.live = false;
      session.lastActivityAt = nowMs();
      pushSession(session);
      return;
    }
    default:
      break;
  }

  // Subagent events also carry a parent session_id: keep that session's
  // activity fresh without touching its hook-derived status.
  if (sessionId) {
    const session = ensureSession(sessionId, cwd, transcript);
    session.lastActivityAt = nowMs();
  }

  switch (ev) {
    case 'SubagentStart': {
      if (!agentId) return;
      const agent = ensureAgent(agentId, agentType, payload.session_id);
      agent.type = agentType || agent.type;
      agent.transcript = transcript || agent.transcript;
      const task = readTaskFromTranscript(transcript);
      if (task) {
        agent.task = cleanTask(task, agent.type);
        agent._taskResolved = true;
      } else {
        attachTaskLater(agentId, transcript);
      }
      pushAgent(agent);
      break;
    }
    case 'PreToolUse': {
      if (!agentId) {
        // Main-session tool call: no agent to track, but it proves the
        // session itself is unblocked. Never creates an agent/card.
        const session = sessionId ? sessions.get(sessionId) : null;
        if (unblockMainSessionOnToolActivity(session)) pushSession(session);
        return;
      }
      const agent = ensureAgent(agentId, agentType, payload.session_id);
      agent.currentTool = tool || agent.currentTool;
      agent.busy = true;
      if (agent.status === 'working') pushAgent(agent);
      else {
        agent.status = 'working';
        pushAgent(agent);
      }
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      if (!agentId) {
        const session = sessionId ? sessions.get(sessionId) : null;
        if (unblockMainSessionOnToolActivity(session)) pushSession(session);
        return;
      }
      const agent = ensureAgent(agentId, agentType, payload.session_id);
      agent.steps += 1;
      agent.lastTool = tool || agent.lastTool;
      agent.busy = false;
      pushAgent(agent);
      break;
    }
    case 'SubagentStop': {
      if (!agentId) return;
      const agent = ensureAgent(agentId, agentType, payload.session_id);
      agent.status = 'done';
      agent.busy = false;
      agent.currentTool = null;
      agent.endedAt = nowMs();
      const tokens = readTokensFromTranscript(transcript || agent.transcript);
      if (tokens != null) agent.tokens = tokens;
      pushAgent(agent);
      break;
    }
    default:
      // Unrecognized subagent-shaped events are logged but do not change cards.
      // Stop/Notification/SessionStart/UserPromptSubmit/SessionEnd are handled
      // above, in the session-lifecycle switch.
      break;
  }

  // Recompute a subagent-only session's status after this event's agent-map
  // mutations (SubagentStart just created an agent, SubagentStop just marked
  // one done, etc), rather than before them, so a brand-new subagent-only
  // session is correctly seen as 'working' on its very first SubagentStart.
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session && !session.sawTopLevel && deriveSubagentOnlyStatus(session)) {
      pushSession(session);
    }
  }
}

// ---------------------------------------------------------------------------
// Statusline ingestion (best effort, never throws)
// ---------------------------------------------------------------------------
// Normalizes one rate_limits window ({used_percentage, resets_at}, resets_at
// in unix SECONDS) into the wire shape ({pct, resetsAt}, resetsAt in ms
// epoch). Returns null for a missing/malformed window so the caller can tell
// "this window was not in the payload" apart from a real 0.
function normalizeRateLimitWindow(win) {
  if (!win || typeof win.used_percentage !== 'number') return null;
  const resetsAt = typeof win.resets_at === 'number' ? win.resets_at * 1000 : null;
  return { pct: win.used_percentage, resetsAt };
}

// POST /statusline handler. The payload is the same JSON Claude Code pipes on
// stdin to the statusLine command (see statusline-feed.mjs); it carries no
// hook_event_name, so this is entirely separate from handleEvent() above.
function handleStatusline(payload) {
  if (!payload || typeof payload !== 'object') return;

  // Resolve the session: by session_id first, then fall back to matching a
  // tracked session by normalized cwd (statusline payloads are not guaranteed
  // to carry a session_id).
  let session = null;
  if (payload.session_id) session = sessions.get(payload.session_id) || null;
  if (!session && payload.cwd) {
    const normalizedCwd = terminal.normalizePath(payload.cwd);
    for (const s of sessions.values()) {
      if (s.cwd && terminal.normalizePath(s.cwd) === normalizedCwd) {
        session = s;
        break;
      }
    }
  }

  if (session) {
    let changed = false;
    const model = payload.model || {};
    if (typeof model.display_name === 'string' && model.display_name !== session.modelDisplay) {
      session.modelDisplay = model.display_name;
      changed = true;
    }
    // This is the only way a backfilled (never-hooked) session ever learns
    // its model: SessionStart normally sets it, but a session discovered by
    // backfillSessions() never gets that hook.
    if (!session.model && typeof model.id === 'string') {
      session.model = model.id;
      changed = true;
    }
    const ctx = payload.context_window || {};
    if (typeof ctx.used_percentage === 'number' && ctx.used_percentage !== session.ctxPct) {
      session.ctxPct = ctx.used_percentage;
      changed = true;
    }
    if (typeof ctx.total_input_tokens === 'number' && ctx.total_input_tokens !== session.ctxTokens) {
      session.ctxTokens = ctx.total_input_tokens;
      changed = true;
    }
    if (typeof ctx.context_window_size === 'number' && ctx.context_window_size !== session.ctxSize) {
      session.ctxSize = ctx.context_window_size;
      changed = true;
    }
    if (typeof payload.session_name === 'string' && payload.session_name.trim() && !session.title) {
      applyLaunchName(session, payload.session_name);
      changed = true;
    }
    // Always advance so the next broadcast (triggered by a real change, here
    // or on a later event) carries a fresh recency timestamp, without forcing
    // a broadcast purely because time passed (statusline fires frequently).
    session.usageAt = nowMs();
    if (changed) pushSession(session);
  }

  // Global usage windows are account-wide, not per-session. The whole
  // rate_limits key is absent when neither window exists yet, so a missing
  // key must never clobber a previously known good value; a present window
  // that failed to normalize (see normalizeRateLimitWindow) falls back to
  // whatever was already known for that window, for the same reason.
  if (payload.rate_limits && typeof payload.rate_limits === 'object') {
    const fiveHour = normalizeRateLimitWindow(payload.rate_limits.five_hour);
    const sevenDay = normalizeRateLimitWindow(payload.rate_limits.seven_day);
    if (fiveHour || sevenDay) {
      const nextFiveHour = fiveHour || (usage && usage.fiveHour) || null;
      const nextSevenDay = sevenDay || (usage && usage.sevenDay) || null;
      const usageChanged =
        !usage ||
        JSON.stringify(usage.fiveHour) !== JSON.stringify(nextFiveHour) ||
        JSON.stringify(usage.sevenDay) !== JSON.stringify(nextSevenDay);
      usage = { fiveHour: nextFiveHour, sevenDay: nextSevenDay, at: nowMs() };
      if (usageChanged) {
        broadcast({ type: 'usage', usage });
        scheduleSaveSessions();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session backfill (best effort, never throws): populate the board with
// recent machine-wide sessions before their hooks ever fire, by scanning
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl and ~/.claude/history.jsonl.
// ---------------------------------------------------------------------------
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const HISTORY_FILE = path.join(HOME, '.claude', 'history.jsonl');
const IDE_DIR = path.join(HOME, '.claude', 'ide');
const BACKFILL_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h
const BACKFILL_MAX_FILES = 40;

// Best-effort decode of an encoded project folder name back to a cwd, used
// only as a fallback when the transcript itself has no usable cwd line.
// Encoding replaces the drive colon and all path separators with '-', so the
// reverse mapping is ambiguous (a real '-' in a folder name looks the same as
// a separator). We only use this to derive a display name, never to open files.
function decodeProjectFolder(folderName) {
  try {
    if (/^[A-Za-z]--/.test(folderName)) {
      return folderName[0] + ':\\' + folderName.slice(3).split('-').join('\\');
    }
  } catch {
    // best effort only
  }
  return null;
}

// Build a Map<sessionId, latest display string> from history.jsonl, one JSON
// object per line: { timestamp, project, sessionId, display }.
function buildHistoryIndex() {
  const index = new Map();
  try {
    if (!fs.existsSync(HISTORY_FILE)) return index;
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!obj || !obj.sessionId || !obj.display) continue;
      const prev = index.get(obj.sessionId);
      if (!prev || (obj.timestamp || 0) >= (prev.timestamp || 0)) {
        index.set(obj.sessionId, { timestamp: obj.timestamp || 0, display: obj.display });
      }
    }
  } catch {
    // best effort only
  }
  return index;
}

// Best-effort live hint: does any ~/.claude/ide/*.lock reference this cwd as
// one of its workspaceFolders? Non-fatal, nice-to-have only.
function isCwdLive(cwd) {
  if (!cwd) return false;
  try {
    if (!fs.existsSync(IDE_DIR)) return false;
    const files = fs.readdirSync(IDE_DIR).filter((f) => f.endsWith('.lock'));
    for (const f of files) {
      try {
        const lock = JSON.parse(fs.readFileSync(path.join(IDE_DIR, f), 'utf8'));
        const folders = (lock && lock.workspaceFolders) || [];
        if (folders.some((wf) => typeof wf === 'string' && wf.replace(/[\\/]+$/, '') === cwd.replace(/[\\/]+$/, ''))) {
          return true;
        }
      } catch {
        // skip unreadable lock file
      }
    }
  } catch {
    // best effort only
  }
  return false;
}

function backfillSessions() {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return;
    const projectFolders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

    // Gather every session transcript with its mtime, across all projects.
    const candidates = [];
    for (const dir of projectFolders) {
      const folderPath = path.join(PROJECTS_DIR, dir.name);
      let files;
      try {
        files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const filePath = path.join(folderPath, f);
        let stat;
        try {
          stat = fs.statSync(filePath);
        } catch {
          continue;
        }
        if (nowMs() - stat.mtimeMs > BACKFILL_WINDOW_MS) continue;
        candidates.push({ filePath, folderName: dir.name, mtimeMs: stat.mtimeMs, id: f.slice(0, -('.jsonl'.length)) });
      }
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const dropped = Math.max(0, candidates.length - BACKFILL_MAX_FILES);
    const chosen = candidates.slice(0, BACKFILL_MAX_FILES);
    if (dropped > 0) {
      process.stdout.write(`backfillSessions: dropped ${dropped} older session file(s) beyond the ${BACKFILL_MAX_FILES}-file cap\n`);
    }

    const historyIndex = buildHistoryIndex();

    let added = 0;
    for (const c of chosen) {
      if (sessions.has(c.id)) continue; // never downgrade a hook-tracked session
      const meta = readSessionMetaFromTranscript(c.filePath);
      let cwd = meta.cwd;
      let project = null;
      if (cwd) {
        project = projectNameFromCwd(cwd);
      } else {
        const decoded = decodeProjectFolder(c.folderName);
        if (decoded) {
          cwd = decoded;
          project = projectNameFromCwd(decoded);
        } else {
          project = c.folderName;
        }
      }
      const branch = meta.branch;
      const hist = historyIndex.get(c.id);
      sessions.set(c.id, {
        id: c.id,
        cwd: cwd || null,
        project,
        branch,
        model: null,
        status: 'recent',
        title: null,
        lastPrompt: hist ? truncateLastPrompt(cleanTask(hist.display, null)) : null,
        startedAt: c.mtimeMs,
        lastActivityAt: c.mtimeMs,
        live: isCwdLive(cwd),
        source: 'backfill',
        transcript: c.filePath,
        modelDisplay: null,
        ctxPct: null,
        ctxTokens: null,
        ctxSize: null,
        usageAt: null,
      });
      added += 1;
    }
    // Only persist when the scan actually added something, so the 30s interval
    // does not rewrite the file on every idle tick.
    if (added > 0) scheduleSaveSessions();
  } catch {
    // backfill is best effort; never throw
  }
}

// ---------------------------------------------------------------------------
// Session registry reconciliation (best effort, never throws)
// ---------------------------------------------------------------------------
// Claude Code maintains ~/.claude/sessions/<pid>.json, one small file per
// currently-running session, which is authoritative ground truth for live
// status: far better than the ~/.claude/ide/*.lock heuristic in isCwdLive()
// above (kept as-is; it still seeds a first guess for a brand-new backfilled
// session before this reconcile pass gets to it). Polled on a short interval
// since the files are tiny and there are only ever a handful.
const SESSIONS_REGISTRY_DIR = path.join(HOME, '.claude', 'sessions');
// Overridable so tests can poll fast without changing the production default.
const REGISTRY_POLL_MS = parseInt(process.env.CMC_REGISTRY_POLL_MS, 10) || 2500;
// A registry file whose statusUpdatedAt is older than this is treated as an
// untrustworthy reading (the writer may have died mid-update without
// removing the file): its mere presence with a live pid still proves the
// session is running, but its status is not used to move ours.
const REGISTRY_STALE_MS = 5 * 60 * 1000; // 5 minutes

// Status vocabulary is not documented. Observed live: 'busy', 'waiting'.
// Also present as string literals in the CLI binary: 'running', 'idle',
// 'blocked'. Mapped defensively below; anything else is left alone (see
// warnedUnknownRegistryStatus) so an unrecognised future value can never
// move a session's status out from under it.
const REGISTRY_STATUS_WORKING = new Set(['busy', 'running']);
const REGISTRY_STATUS_WAITING = new Set(['waiting', 'idle', 'blocked']);
// Logged once per distinct unknown value (not once per poll), so an
// unrecognised status is discoverable without spamming the console.
const warnedUnknownRegistryStatus = new Set();

// process.kill(pid, 0) is a signal-free existence probe on every platform
// Node supports, including Windows. Used to skip a stale registry file left
// behind by a process that crashed instead of cleaning up after itself.
function registryPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // exists but not signalable: still alive
  }
}

// Session ids backed by a live, pid-verified registry file as of the last
// poll. Diffed against the current poll so a file that disappears (session
// exited) or whose pid died (crashed without cleanup) can be detected and
// downgraded exactly once, the same tick it happens rather than lingering.
let lastRegistryLiveSessionIds = new Set();

function reconcileSessionRegistry() {
  let files;
  try {
    files = fs.existsSync(SESSIONS_REGISTRY_DIR)
      ? fs.readdirSync(SESSIONS_REGISTRY_DIR).filter((f) => f.endsWith('.json'))
      : [];
  } catch {
    return; // best effort only
  }

  const now = nowMs();
  const nowLiveIds = new Set();

  for (const file of files) {
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(SESSIONS_REGISTRY_DIR, file), 'utf8'));
    } catch {
      continue; // half-written this tick, or otherwise unreadable: skip, not fatal
    }
    if (!entry || !entry.sessionId) continue;
    if (!registryPidAlive(entry.pid)) continue; // stale file for a dead process

    nowLiveIds.add(entry.sessionId);

    const session = ensureSession(entry.sessionId, entry.cwd, null);
    let changed = false;

    if (!session.live) {
      session.live = true;
      changed = true;
    }

    // name is a direct, universal source for a session's display name (every
    // named session, not only ones launched from Mission Control), strictly
    // better than the bindSession deferred-join, which stays in place as a
    // fallback for the moment before this registry file exists.
    if (typeof entry.name === 'string' && entry.name.trim() && !session.title) {
      applyLaunchName(session, entry.name);
      changed = true;
    }

    const statusUpdatedAt = typeof entry.statusUpdatedAt === 'number' ? entry.statusUpdatedAt : null;
    const trustworthy = statusUpdatedAt === null || now - statusUpdatedAt <= REGISTRY_STALE_MS;
    const rawStatus = typeof entry.status === 'string' ? entry.status : null;

    if (trustworthy && rawStatus) {
      if (REGISTRY_STATUS_WORKING.has(rawStatus)) {
        // Always wins, even over 'needs-permission': this is what actually
        // clears a stale blocked status once the session's own tool activity
        // resumes (belt-and-suspenders alongside the PreToolUse/PostToolUse
        // fix above, since the registry is authoritative either way).
        if (session.status !== 'working') {
          session.status = 'working';
          changed = true;
        }
      } else if (REGISTRY_STATUS_WAITING.has(rawStatus)) {
        if (session.status === 'needs-permission') {
          // Keep: a permission prompt is a more specific kind of waiting
          // than the registry's generic 'waiting'/'idle'/'blocked'.
        } else if (session.status !== 'awaiting') {
          session.status = 'awaiting';
          changed = true;
        }
      } else if (!warnedUnknownRegistryStatus.has(rawStatus)) {
        warnedUnknownRegistryStatus.add(rawStatus);
        console.warn(
          `reconcileSessionRegistry: unrecognised registry status "${rawStatus}" ` +
          '(leaving this session\'s status untouched; will not warn again for this value)'
        );
      }
    }

    if (changed) {
      session.lastActivityAt = now;
      pushSession(session);
    }
  }

  // Anything live last poll but not this poll lost its registry backing
  // (process exited, or its pid died without cleanup): clear live and, if it
  // was in an in-flight status, degrade it to 'recent' rather than 'ended'
  // (only a real SessionEnd hook may set that), matching how a rehydrated
  // session is downgraded on startup in loadPersistedSessions() above.
  for (const id of lastRegistryLiveSessionIds) {
    if (nowLiveIds.has(id)) continue;
    const session = sessions.get(id);
    if (!session) continue;
    const before = session.status;
    const wasLive = session.live;
    session.live = false;
    downgradeToRecentIfInFlight(session);
    if (wasLive || session.status !== before) pushSession(session);
  }

  lastRegistryLiveSessionIds = nowLiveIds;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// Serve a file from PUBLIC_DIR if (and only if) the resolved path stays inside it.
function serveStatic(res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const resolved = path.resolve(PUBLIC_DIR, rel);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
  serveFile(res, resolved, type);
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify(snapshotPayload())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // ignore
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && url === '/event') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) req.destroy(); // guard against runaway payloads
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        handleEvent(payload);
      } catch {
        // a malformed payload must never crash the server
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }

  if (req.method === 'POST' && url === '/statusline') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) req.destroy(); // guard against runaway payloads
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        handleStatusline(payload);
      } catch {
        // a malformed payload must never crash the server
      }
      res.writeHead(204);
      res.end();
    });
    return;
  }

  if (req.method === 'GET' && url === '/repos') {
    const repos = terminal.listRepos();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(repos));
    return;
  }

  if (req.method === 'POST' && url === '/launch') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) req.destroy(); // guard against runaway payloads
    });
    req.on('end', () => {
      let result;
      try {
        const payload = JSON.parse(body || '{}');
        const repo = payload.repo;
        const title = payload.title || path.basename(String(repo || '').replace(/[\\/]+$/, ''));
        // `name` is optional: when set it becomes the Claude display name
        // (claude --name) and the tab title, and lands on the session record
        // once the first hook lets terminal.bindSession() join the two.
        result = terminal.launchSession(repo, title, payload.name);
      } catch (error) {
        result = { ok: false, error: String(error) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (req.method === 'POST' && url === '/focus') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) req.destroy(); // guard against runaway payloads
    });
    req.on('end', () => {
      let result;
      try {
        const payload = JSON.parse(body || '{}');
        const sessionId = payload.sessionId;
        const session = sessions.get(sessionId);
        const cwd = session ? session.cwd : null;
        result = terminal.focusSession(sessionId, cwd);
      } catch (error) {
        result = { ok: false, error: String(error) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (req.method === 'POST' && url === '/reopen') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5_000_000) req.destroy(); // guard against runaway payloads
    });
    req.on('end', () => {
      let result;
      try {
        const payload = JSON.parse(body || '{}');
        const sessionId = payload.sessionId;
        const session = sessions.get(sessionId);
        const cwd = session ? session.cwd : null;
        const title = session ? session.title : null;
        result = terminal.reopenSession(sessionId, cwd, title);
      } catch (error) {
        result = { ok: false, error: String(error) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(res, url);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  try {
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ port: PORT, pid: process.pid, startedAt: nowMs() })
    );
  } catch {
    // if we cannot write the lock, the shim simply will not find us (safe)
  }
  process.stdout.write(`agent-fleet-monitor listening at http://localhost:${PORT}\n`);
  loadPersistedSessions();
  loadPersistedUsage();
  backfillSessions();
  setInterval(backfillSessions, 30000);
  reconcileSessionRegistry();
  setInterval(reconcileSessionRegistry, REGISTRY_POLL_MS);
});

function shutdown() {
  // Flush any pending debounced session write so a clean stop does not lose the
  // last mutation. Best effort; saveSessionsNow never throws.
  saveSessionsNow();
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (lock && lock.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    // ignore
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
