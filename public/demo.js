// In-browser demo mode: a deterministic, looping scripted "fleet" scenario
// driven purely through Store.ingest(...) on timers. No server, no SSE.
// Activated by index.html's inline boot script when the URL has a ?demo
// query param (see the DEMO ACTIVATION comment there); never runs otherwise.
(function () {
  var TICK_MIN = 1000, TICK_MAX = 3000;   // ms between scripted beats
  var CYCLE_PAUSE = 2200;                 // extra dwell time before the loop resets

  function rand(min, max) { return Math.floor(min + Math.random() * (max - min)); }
  function nextDelay() { return rand(TICK_MIN, TICK_MAX); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var timer = null;

  // ---- Fixed corner chip, created once, left up for the whole demo run. ----
  function showRibbon() {
    if (document.querySelector('.demo-ribbon')) return;
    var el = document.createElement('div');
    el.className = 'demo-ribbon';
    el.textContent = 'DEMO';
    el.title = 'Scripted demo data, not a live session.';
    document.body.appendChild(el);
  }

  // ---- Scenario data: 3 fake sessions across different fake projects, and a
  // handful of subagents attributed to the busiest one. Rebuilt fresh on every
  // loop so startedAt/lastActivityAt stay realistic relative to "now". ----
  function buildScenario() {
    var base = Date.now();
    var sessAlpha = {
      id: 'demo-session-alpha', cwd: 'C:/Users/demo/repos/zrm-crm-portal', project: 'zrm-crm-portal',
      branch: 'feature/invoice-export', model: 'claude-opus-4-8', status: 'working',
      title: 'Invoice export pipeline', lastPrompt: 'Add CSV export for overdue invoices to the billing dashboard',
      startedAt: base - 9 * 60000, lastActivityAt: base, live: true, source: 'demo'
    };
    var sessBravo = {
      id: 'demo-session-bravo', cwd: 'C:/Users/demo/repos/aigentur-web', project: 'aigentur-web',
      branch: 'main', model: 'claude-sonnet-5', status: 'working',
      title: 'Landing page revamp', lastPrompt: 'Refresh the hero section copy and add a pricing table',
      startedAt: base - 6 * 60000, lastActivityAt: base, live: true, source: 'demo'
    };
    var sessCharlie = {
      id: 'demo-session-charlie', cwd: 'C:/Users/demo/repos/cvrintegration-api', project: 'cvrintegration-api',
      branch: 'fix/rate-limit', model: 'claude-sonnet-5', status: 'awaiting',
      title: 'CVR API rate limit fix', lastPrompt: 'Investigate intermittent 429s from the CVR lookup endpoint',
      startedAt: base - 3 * 60000, lastActivityAt: base, live: true, source: 'demo'
    };
    var sessions = [sessAlpha, sessBravo, sessCharlie];

    function agent(id, type, task, parentSession, extra) {
      var a = {
        id: id, type: type, task: task, status: 'working', busy: false,
        currentTool: null, lastTool: null, steps: 0, tokens: 0,
        startedAt: base, endedAt: null, parentSession: parentSession
      };
      for (var k in extra) { if (extra.hasOwnProperty(k)) a[k] = extra[k]; }
      return a;
    }
    var agents = [
      agent('demo-agent-explore', 'Explore', 'Explore invoice export requirements across services', sessAlpha.id),
      agent('demo-agent-build', 'general-purpose', 'Wire the CSV export endpoint and streaming writer', sessAlpha.id),
      agent('demo-agent-review', 'code-reviewer', 'Review the invoice export PR for edge cases', sessAlpha.id),
      agent('demo-agent-test', 'test', 'Write integration tests for the export endpoint', sessAlpha.id),
      agent('demo-agent-plan', 'Plan', 'Draft the rollout plan for the invoice export feature', sessAlpha.id),
      // A lightly active agent on another session, just so its card shows a
      // subagent count too; not part of the main showcased cycle.
      agent('demo-agent-bravo-copy', 'general-purpose', 'Rewrite the hero section copy', sessBravo.id,
        { busy: true, currentTool: 'Edit', steps: 4, tokens: 900 })
    ];

    return { sessions: sessions, agents: agents };
  }

  // Pick the session with the most attributed subagents, i.e. the most
  // activity, to auto-select and showcase in the office + lanes detail view.
  function busiestSessionId(sessions, agents) {
    var counts = {};
    agents.forEach(function (a) { counts[a.parentSession] = (counts[a.parentSession] || 0) + 1; });
    var bestId = sessions[0].id, bestCount = -1;
    sessions.forEach(function (s) {
      var c = counts[s.id] || 0;
      if (c > bestCount) { bestCount = c; bestId = s.id; }
    });
    return bestId;
  }

  function runCycle() {
    var scenario = buildScenario();
    var sessions = scenario.sessions, agents = scenario.agents;
    var sessById = {}; sessions.forEach(function (s) { sessById[s.id] = s; });
    var agentById = {}; agents.forEach(function (a) { agentById[a.id] = a; });

    function subagentCount(sessionId) {
      var n = 0;
      agents.forEach(function (a) { if (a.parentSession === sessionId) n += 1; });
      return n;
    }
    function sessionWire(s) {
      var w = clone(s);
      w.subagentCount = subagentCount(s.id);
      return w;
    }

    var firstSeenAt = sessions.reduce(function (m, s) { return Math.min(m, s.startedAt); }, agents.reduce(function (m, a) { return Math.min(m, a.startedAt); }, Date.now()));

    Store.ingest({
      type: 'snapshot',
      firstSeenAt: firstSeenAt,
      agents: agents.map(clone),
      sessions: sessions.map(sessionWire)
    });

    var conn = document.getElementById('conn');
    var connText = document.getElementById('connText');
    if (conn) conn.classList.add('live');
    if (connText) connText.textContent = 'demo';

    Store.selectSession(busiestSessionId(sessions, agents));
    showRibbon();

    function sendAgent(a) { Store.ingest({ type: 'agent', agent: clone(a) }); }
    function sendSession(s) { s.lastActivityAt = Date.now(); Store.ingest({ type: 'session', session: sessionWire(s) }); }

    function useTool(a, tool, tokenGain) {
      if (a.currentTool) a.lastTool = a.currentTool;
      a.currentTool = tool;
      a.busy = true;
      a.steps += 1;
      a.tokens += tokenGain;
      sendAgent(a);
    }
    function finishDone(a) {
      a.lastTool = a.currentTool;
      a.currentTool = null;
      a.busy = false;
      a.status = 'done';
      a.endedAt = Date.now();
      sendAgent(a);
    }
    function finishError(a) {
      a.lastTool = a.currentTool;
      a.currentTool = null;
      a.busy = false;
      a.status = 'error';
      a.endedAt = Date.now();
      sendAgent(a);
    }

    var explore = agentById['demo-agent-explore'];
    var build = agentById['demo-agent-build'];
    var review = agentById['demo-agent-review'];
    var test = agentById['demo-agent-test'];
    var plan = agentById['demo-agent-plan'];
    var charlie = sessById['demo-session-charlie'];
    var alpha = sessById['demo-session-alpha'];

    // The scripted "beats" of one full cycle: tool cycling (Bash, Read, Grep,
    // Edit, WebFetch all touched), a needs-permission attention window, a
    // done celebration, and at least one error, in that rough order.
    var beats = [
      function () { useTool(explore, 'Bash', 140); },
      function () { useTool(build, 'Read', 220); },
      function () { useTool(review, 'Grep', 90); },
      function () { useTool(explore, 'Read', 260); },
      function () { useTool(test, 'Bash', 120); },
      function () { useTool(build, 'Edit', 340); },
      function () { useTool(plan, 'WebFetch', 180); },
      function () { useTool(review, 'Edit', 210); },
      function () { charlie.status = 'needs-permission'; sendSession(charlie); },
      function () { useTool(explore, 'Grep', 130); },
      function () { finishDone(test); },
      function () { useTool(build, 'WebFetch', 260); },
      function () { finishError(plan); },
      function () { useTool(review, 'Read', 150); },
      function () { charlie.status = 'working'; sendSession(charlie); },
      function () { finishDone(explore); },
      function () { useTool(build, 'Grep', 90); },
      function () { finishDone(review); },
      function () { finishDone(build); },
      function () { alpha.status = 'awaiting'; sendSession(alpha); }
    ];

    playBeats(beats, 0);
  }

  function playBeats(beats, i) {
    if (i >= beats.length) {
      timer = setTimeout(runCycle, nextDelay() + CYCLE_PAUSE);
      return;
    }
    beats[i]();
    timer = setTimeout(function () { playBeats(beats, i + 1); }, nextDelay());
  }

  window.Demo = {
    // Seeds the initial snapshot, auto-selects the busiest session (so the
    // office + lanes detail view shows immediately) and starts the looping
    // scripted cycle. Never calls Store.connect(); there is no server behind
    // demo mode.
    start: function () {
      if (timer) { clearTimeout(timer); timer = null; }
      runCycle();
    }
  };
})();
