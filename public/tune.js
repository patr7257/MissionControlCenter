/* Mission Control Center: the "Claude's Plan" easter egg (issue #39).
 *
 * Clicking the Claude mark in the header starts the tune; clicking it again
 * stops it. Nothing else in the app plays audio, and nothing here ever starts
 * on its own: the AudioContext is built on the first click, which is also what
 * browsers require before any sound is allowed.
 *
 * WHY IT IS SYNTHESISED RATHER THAN STREAMED. The issue offered the Spotify dev
 * app from patr7257/music-timeline-quiz as one option. That is out: this repo's
 * hard constraint is zero runtime dependencies, no CDN, no external network
 * calls, works fully offline. The Spotify route needs a CDN script, an OAuth
 * round trip, a Premium session and live network, so the board would sit behind
 * a login prompt the moment it were offline. The issue's own fallback ("create
 * just the 'claudes plan' part of the chorus") is what this is: a short hook
 * built out of oscillators, about 1KB, no asset, no request, no permission.
 *
 * Be honest about what that means: the Web Audio API makes TONES, it cannot
 * sing. This is the instrumental hook, not the vocal. If the actual recording is
 * wanted, that is a bundled audio file and a separate decision.
 */
var Tune = (function () {
  'use strict';

  // The hook, as scale degrees against a root, so the whole phrase can be
  // transposed by changing ROOT alone. Rhythm is in beats.
  // The shape is the chant: four short syllables that land on the tonic, then a
  // lift and a fall back, sung as "that - is - Claude's - plan".
  var ROOT = 293.6648; // D4
  var BPM = 104;
  var BEAT = 60 / BPM;

  // semitones above ROOT, duration in beats
  var LEAD = [
    { s: 0, d: 0.5 }, { s: 0, d: 0.5 }, { s: 3, d: 0.5 }, { s: 5, d: 0.5 },
    { s: 7, d: 1.0 }, { s: 5, d: 0.5 }, { s: 3, d: 0.5 },
    { s: 5, d: 0.5 }, { s: 3, d: 0.5 }, { s: 0, d: 1.0 },
    { s: -2, d: 0.5 }, { s: 0, d: 1.5 }
  ];
  // The bass keeps the pulse under it, one note per two beats.
  var BASS = [
    { s: -24, d: 2 }, { s: -19, d: 2 }, { s: -17, d: 2 }, { s: -24, d: 2 }
  ];

  var PHRASE_BEATS = 8;
  var PHRASE_SEC = PHRASE_BEATS * BEAT;

  var ctx = null;
  var master = null;
  var timer = null;
  var nextAt = 0;
  var playing = false;
  var listeners = [];

  function hz(semitones) {
    return ROOT * Math.pow(2, semitones / 12);
  }

  // One voice: an oscillator through its own gain envelope. Each note gets a
  // fresh oscillator (they are single-use by design) and stops itself, so
  // nothing accumulates while the loop runs.
  function note(type, freq, at, dur, peak, detune) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (detune) osc.detune.setValueAtTime(detune, at);
    // Short attack, gentle decay to a sustain, release before the next note, so
    // the phrase reads as played rather than as a square wave being switched.
    var attack = 0.012;
    var release = Math.min(0.09, dur * 0.4);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(peak * 0.55, at + Math.min(dur * 0.5, 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(at);
    osc.stop(at + dur + release);
  }

  // Schedule one pass of the phrase starting at `at` (an AudioContext time).
  function schedulePhrase(at) {
    var t = at;
    for (var i = 0; i < LEAD.length; i++) {
      var dur = LEAD[i].d * BEAT;
      // Two detuned saws an octave apart: enough body to sound deliberate
      // without a filter chain.
      note('triangle', hz(LEAD[i].s), t, dur * 0.92, 0.16, 0);
      note('sawtooth', hz(LEAD[i].s), t, dur * 0.92, 0.045, 7);
      t += dur;
    }
    t = at;
    for (var j = 0; j < BASS.length; j++) {
      var bd = BASS[j].d * BEAT;
      note('sine', hz(BASS[j].s), t, bd * 0.9, 0.22, 0);
      t += bd;
    }
  }

  // Look ahead a phrase at a time rather than scheduling the whole loop up
  // front: stopping then only has to cancel a timer and fade what is already
  // queued, instead of chasing hundreds of scheduled oscillators.
  function pump() {
    if (!playing) return;
    while (nextAt < ctx.currentTime + PHRASE_SEC) {
      schedulePhrase(nextAt);
      nextAt += PHRASE_SEC;
    }
    timer = setTimeout(pump, PHRASE_SEC * 500);
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](playing);
      } catch (e) {
        // A broken listener must never take the audio down with it.
      }
    }
  }

  function start() {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    if (!ctx) {
      // Fail silent, never throw: a machine with no audio device, or a policy
      // that refuses the context outright, must cost a dead click and nothing
      // more. The caller reads the return value, so the button stays honest.
      try {
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = 0;
        master.connect(ctx.destination);
      } catch (e) {
        ctx = null;
        master = null;
        return false;
      }
    }
    // A context created before a gesture can start suspended; resume is a no-op
    // when it is already running.
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    playing = true;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 0.06);
    nextAt = ctx.currentTime + 0.06;
    pump();
    emit();
    return true;
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    playing = false;
    if (ctx && master) {
      // Ramp instead of cutting: yanking the gain to zero clicks audibly.
      var now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), now);
      master.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    }
    emit();
  }

  return {
    isPlaying: function () { return playing; },
    toggle: function () {
      if (playing) {
        stop();
        return false;
      }
      return start();
    },
    stop: stop,
    // The mark subscribes so its pressed state always follows the audio, rather
    // than each click flipping a class the audio might not have honoured.
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };
})();
