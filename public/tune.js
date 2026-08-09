/* Mission Control Center: the "Claude's Plan" easter egg (issues #39, #44).
 *
 * Clicking the Claude mark in the header plays the tune; clicking it again
 * stops it. Nothing else in the app plays audio, and nothing here ever starts
 * on its own: playback only happens from a real click, which is also what
 * browsers require before they allow sound.
 *
 * WHY A BUNDLED FILE. The first version of this synthesised a melody with the
 * Web Audio API. That kept the app offline but played the WRONG THING: the
 * Web Audio API makes tones and cannot sing, and the joke in "Claude's Plan"
 * (Jeff Guo's cover of "God's Plan") is the lyrics, so oscillators could never
 * deliver it. Streaming from Spotify was the other option in #39 and is ruled
 * out by this repo's hard constraint: zero runtime dependencies, no CDN, no
 * external network calls, works fully offline. A local file played by a plain
 * <audio> element satisfies all of that AND plays the actual song, so it wins
 * on every axis. The clip ships inside the MSI through the existing public/**
 * glob in desktop/electron-builder.yml.
 *
 * The API is deliberately unchanged from the oscillator version (toggle, stop,
 * isPlaying, onChange), so public/index.html's wiring and the mark's
 * pressed-state binding did not have to move.
 */
var Tune = (function () {
  'use strict';

  var SRC = '/claudes-plan.mp3';

  var audio = null;
  var listeners = [];

  function emit() {
    var playing = Tune.isPlaying();
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](playing);
      } catch (e) {
        // A broken listener must never take playback down with it.
      }
    }
  }

  // Built on first use rather than at load: no network or decode work happens
  // for a board nobody clicks the mark on. preload='none' is the same idea, so
  // the ~900KB clip is only fetched when it is actually wanted.
  function el() {
    if (audio) return audio;
    try {
      audio = new Audio(SRC);
      audio.preload = 'none';
      // The element's own events are the single source of truth for the
      // pressed state. Painting from the CLICK instead would let the button
      // claim to be playing while the browser refused, which is the exact
      // failure the oscillator version was careful to avoid too.
      audio.addEventListener('play', emit);
      audio.addEventListener('pause', emit);
      audio.addEventListener('ended', emit);
      audio.addEventListener('error', emit);
    } catch (e) {
      audio = null;
    }
    return audio;
  }

  function stop() {
    var a = audio;
    if (!a) return;
    try {
      a.pause();
      // Rewind, so the next click starts the song rather than resuming it
      // halfway. 'pause' has already fired the state change by now.
      a.currentTime = 0;
    } catch (e) {
      // A pause on a not-yet-loaded element can throw; nothing to recover.
    }
  }

  return {
    // Deliberately derived from the element instead of a flag we maintain:
    // there is then no way for our idea of the state and the browser's to
    // disagree. 'ended' leaves paused true, so the button clears itself when
    // the song finishes.
    isPlaying: function () {
      return !!audio && !audio.paused && !audio.ended;
    },
    toggle: function () {
      if (Tune.isPlaying()) {
        stop();
        return false;
      }
      var a = el();
      if (!a) return false;
      try {
        var p = a.play();
        // play() returns a promise in every current browser. A rejection
        // (autoplay policy, missing file, no audio device) must leave the
        // button unpressed rather than throw, so swallow it and let the
        // element's own events decide what the mark shows.
        if (p && typeof p.catch === 'function') p.catch(function () { emit(); });
        return true;
      } catch (e) {
        return false;
      }
    },
    stop: stop,
    // The mark subscribes so its pressed state always follows the audio.
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };
})();
