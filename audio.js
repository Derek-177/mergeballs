/* Merge Ball - merge sound system (Web Audio API)
 *
 * Every successful merge creates its own AudioBufferSourceNode + GainNode, so
 * sounds overlap naturally and never cut each other off. The sound played is
 * the one assigned to the ball the merge CREATES; balls without their own
 * sound use the "all merges" sound (uploaded, or the built-in default).
 * Volume / pitch are read when a sound is triggered, so changing them never
 * affects sounds that are already playing.
 *
 * The game keeps working if anything in here fails: every public entry point
 * is wrapped in try/catch and returns quietly.
 */
(function (global) {
  'use strict';

  var KEY = 'mergeball.audio.v1';
  var DEFAULTS = { enabled: true, volume: 0.8, pitch: 1 };
  var MAX_BYTES = 15 * 1024 * 1024;
  var MAX_VOICES = 64;

  var S = { enabled: DEFAULTS.enabled, volume: DEFAULTS.volume, pitch: DEFAULTS.pitch };
  var ctx = null, master = null, comp = null;
  var defaultBuf = null;        // built-in merge sound, rendered once from oscillators
  var customBuf = null;         // "all merges" upload
  var customName = '';
  var failed = false;           // AudioContext could not be created
  var stats = { requested: 0, played: 0, previews: 0, active: 0, skipped: 0 };
  var ui = {};
  var recDest = null, recDelay = null;   // recording tap (only connected while recording video)

  function noop() {}
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function gainFor(v) { return v * v; } // perceptually smoother slider

  /* ---------- settings ---------- */
  function load() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o) {
        S.enabled = o.enabled !== false;
        if (typeof o.volume === 'number') S.volume = clamp(o.volume, 0, 1);
        if (typeof o.pitch === 'number') S.pitch = clamp(o.pitch, 0.5, 2);
      }
    } catch (e) {}
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

  /* ---------- saved sounds (IndexedDB) ---------- */
  // Uploaded sounds are kept here so they are still there after a reload.
  // If IndexedDB is unavailable everything still works for the current visit.
  var dbp = null;
  function openDb() {
    return new Promise(function (res) {
      try {
        var rq = indexedDB.open('mergeball-sounds', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('sounds'); };
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = rq.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function tx(mode, fn) {
    dbp = dbp || openDb();
    return dbp.then(function (d) {
      if (!d) return null;
      return new Promise(function (res) {
        try {
          var t = d.transaction('sounds', mode), r = fn(t.objectStore('sounds'));
          t.oncomplete = function () { res(r && r.result !== undefined ? r.result : true); };
          t.onerror = t.onabort = function () { res(null); };
        } catch (e) { res(null); }
      });
    });
  }
  var soundStore = {
    put: function (k, blob, name) { return tx('readwrite', function (s) { return s.put({ blob: blob, name: name }, k); }); },
    get: function (k) { return tx('readonly', function (s) { return s.get(k); }).then(function (r) { return r && r !== true ? r : null; }); },
    del: function (k) { return tx('readwrite', function (s) { return s.delete(k); }); },
    clear: function () { return tx('readwrite', function (s) { return s.clear(); }); },
    // remove every per-ball sound but keep the "all merges" one
    clearBalls: function () {
      return tx('readwrite', function (s) {
        var rq = s.getAllKeys();
        rq.onsuccess = function () { rq.result.forEach(function (k) { if (k !== 'global') s.delete(k); }); };
        return rq;
      });
    }
  };

  /* ---------- default sound: oscillator "pop + chime" ---------- */
  // Builds the sound into `dest` on any (live or offline) context.
  function buildSynth(c, dest, t0, pitch) {
    function tone(type, f0, f1, start, dur, peak, glide) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0 * pitch, start);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1 * pitch, start + glide);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      o.connect(g); g.connect(dest);
      o.start(start); o.stop(start + dur + 0.02);
    }
    tone('sine', 300, 760, t0, 0.20, 0.55, 0.09);                 // soft rising "bloop"
    tone('triangle', 880.0, 880.0, t0 + 0.045, 0.34, 0.28, 0);    // two-note sparkle (A5 -> E6)
    tone('triangle', 1318.5, 1318.5, t0 + 0.10, 0.42, 0.24, 0);
    tone('sine', 1760.0, 1760.0, t0 + 0.045, 0.22, 0.10, 0);
    tone('sine', 2637.0, 2637.0, t0 + 0.10, 0.28, 0.07, 0);
  }
  // Render once into an AudioBuffer so every merge plays it through its own AudioBufferSourceNode.
  function renderDefault() {
    try {
      var Off = global.OfflineAudioContext || global.webkitOfflineAudioContext;
      if (!Off) return;
      var sr = 44100, oc = new Off(1, Math.ceil(sr * 0.65), sr);
      buildSynth(oc, oc.destination, 0.005, 1);
      var p = oc.startRendering(function (b) { defaultBuf = b; });
      if (p && p.then) p.then(function (b) { defaultBuf = b; }, noop);
    } catch (e) {}
  }

  /* ---------- context lifecycle ---------- */
  function ensureContext() {
    if (ctx || failed) return ctx;
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) { failed = true; return null; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 1;
      comp = ctx.createDynamicsCompressor(); // keeps dense chain merges from clipping
      comp.threshold.value = -14; comp.ratio.value = 4;
      master.connect(comp); comp.connect(ctx.destination);
      ctx.onstatechange = refreshStatus;
    } catch (e) { failed = true; ctx = null; }
    return ctx;
  }

  // Must be called from a user gesture the first time.
  function unlock() {
    try {
      var c = ensureContext();
      if (!c) return Promise.resolve(false);
      var p = c.state !== 'running' ? c.resume() : null;
      try { // silent sample: fully unlocks audio on some mobile browsers
        var b = c.createBuffer(1, 1, 22050), s = c.createBufferSource();
        s.buffer = b; s.connect(c.destination); s.start(0);
      } catch (e) {}
      return Promise.resolve(p).then(function () {
        refreshStatus(); return c.state === 'running';
      }, function () { refreshStatus(); return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  var unlockEvents = ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'click', 'keydown'];
  function onGesture() {
    unlock().then(function (ok) {
      if (ok) unlockEvents.forEach(function (n) { global.removeEventListener(n, onGesture, true); });
    });
  }

  /* ---------- playback ---------- */
  // own = the AudioBuffer assigned to the ball being created (optional)
  function startVoice(own) {
    var buf = own || customBuf || defaultBuf;
    var g = ctx.createGain();
    g.gain.value = gainFor(S.volume);       // volume captured at trigger time
    g.connect(master);
    if (!buf) {                              // fallback if offline render is unavailable
      buildSynth(ctx, g, ctx.currentTime + 0.005, S.pitch);
      return true;
    }
    var src = ctx.createBufferSource();      // a NEW source node for every sound
    src.buffer = buf;
    src.playbackRate.value = S.pitch;        // pitch captured at trigger time
    src._mbKind = 'merge';
    src.connect(g);
    stats.active++;
    src.onended = function () {
      stats.active--;
      try { src.disconnect(); g.disconnect(); } catch (e) {}
    };
    src.start(0);
    return true;
  }

  // Called once per successful merge from the game's merge processing.
  function playMerge(ownBuf) {
    stats.requested++;
    try {
      if (!S.enabled || failed || !ctx) { stats.skipped++; return false; }
      if (ctx.state !== 'running') {         // browser has not allowed audio (yet)
        try { var p = ctx.resume(); if (p && p.catch) p.catch(noop); } catch (e) {}
        stats.skipped++; return false;
      }
      if (stats.active >= MAX_VOICES) { stats.skipped++; return false; }
      startVoice(ownBuf);
      stats.played++;
      return true;
    } catch (e) { stats.skipped++; return false; }
  }

  function preview(ownBuf) {
    return unlock().then(function (ok) {
      if (!ok || !ctx || ctx.state !== 'running') { setStatus('Audio is blocked or unavailable in this browser.'); return false; }
      try { startVoice(ownBuf); stats.previews++; return true; } catch (e) { return false; }
    });
  }

  /* ---------- decoding uploads ---------- */
  function decode(c, ab) {
    return new Promise(function (res, rej) {
      var p = c.decodeAudioData(ab, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }
  // Decoding with an offline context needs no user gesture, so saved sounds can be restored at page load.
  function decodeAny(ab) {
    var Off = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (Off) return decode(new Off(1, 1, 44100), ab);
    var c = ensureContext();
    return c ? decode(c, ab) : Promise.reject(new Error('no audio'));
  }
  function okType(f) {
    var n = (f.name || '').toLowerCase();
    return /\.(mp3|wav|wave|ogg|oga)$/.test(n) ||
      /^audio\/(mpeg|mp3|wav|x-wav|wave|ogg|vorbis)/.test(f.type || '');
  }
  function readBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = rej;
      fr.readAsArrayBuffer(file);
    });
  }
  function decodeBlob(blob) { return readBuffer(blob).then(decodeAny); }
  // Validates and decodes an uploaded file -> {buf, name}; rejects with a readable message.
  function decodeFile(file) {
    if (!file) return Promise.reject(new Error('No file chosen.'));
    if (!okType(file)) return Promise.reject(new Error('Please choose an MP3, WAV or OGG file.'));
    if (file.size > MAX_BYTES) return Promise.reject(new Error('File is too large (15 MB max).'));
    return decodeBlob(file).then(function (buf) { return { buf: buf, name: file.name }; },
      function () { throw new Error('Could not decode that file. Try another MP3, WAV or OGG.'); });
  }

  /* ---------- "all merges" sound ---------- */
  function loadFile(file) {
    return decodeFile(file).then(function (r) {
      customBuf = r.buf; customName = r.name;
      soundStore.put('global', file, file.name);
      refreshUi(); setStatus('Loaded: ' + r.name);
      return true;
    }, function (e) {
      setStatus(e && e.message ? e.message : 'Could not load that file.');
      return false;
    });
  }
  function removeCustom() {
    customBuf = null; customName = '';
    soundStore.del('global');
    refreshUi(); setStatus('Using the default sound.');
  }
  function restoreDefaults() {
    removeCustom();
    S.enabled = DEFAULTS.enabled; S.volume = DEFAULTS.volume; S.pitch = DEFAULTS.pitch;
    save(); refreshUi(); setStatus('Audio settings restored.');
  }
  function restoreSaved() {
    soundStore.get('global').then(function (rec) {
      if (!rec || !rec.blob) return;
      return decodeBlob(rec.blob).then(function (buf) {
        if (customBuf) return;               // user already picked another one meanwhile
        customBuf = buf; customName = rec.name || 'sound';
        refreshUi();
      });
    }).catch(noop);
  }

  /* ---------- recording tap ---------- */
  // Returns a MediaStream carrying everything the game plays, or null if unavailable.
  // delayMs delays only the sound inside the video (fine-tuning of audio/video sync).
  function startRecordingAudio(delayMs) {
    try {
      var c = ensureContext();
      if (!c || !c.createMediaStreamDestination) return null;
      if (!recDest) recDest = c.createMediaStreamDestination();
      stopRecordingAudio();
      var d = clamp((+delayMs || 0) / 1000, 0, 0.5);
      if (d > 0 && c.createDelay) {
        recDelay = c.createDelay(1);
        recDelay.delayTime.value = d;
        comp.connect(recDelay); recDelay.connect(recDest);
      } else {
        comp.connect(recDest);
      }
      return recDest.stream;
    } catch (e) { return null; }
  }
  function stopRecordingAudio() {
    try { if (recDest && comp) comp.disconnect(recDest); } catch (e) {}
    try { if (recDelay) { comp.disconnect(recDelay); recDelay.disconnect(); } } catch (e) {}
    recDelay = null;
  }

  /* ---------- settings panel wiring ---------- */
  function setStatus(msg) { if (ui.status) ui.status.textContent = msg || ''; }
  function refreshStatus() {
    if (!ui.status) return;
    if (failed) setStatus('Audio is unavailable in this browser. The game works without it.');
  }
  function refreshUi() {
    if (!ui.enabled) return;
    ui.enabled.checked = S.enabled;
    ui.volume.value = Math.round(S.volume * 100);
    ui.pitch.value = S.pitch;
    ui.volVal.textContent = Math.round(S.volume * 100) + '%';
    ui.pitchVal.textContent = S.pitch.toFixed(2) + '\u00d7';
    ui.name.textContent = customBuf ? customName : 'Default sound';
    ui.remove.disabled = !customBuf;
  }
  function bind() {
    var $ = function (id) { return document.getElementById(id); };
    ui = {
      enabled: $('audEnabled'), volume: $('audVolume'), pitch: $('audPitch'),
      volVal: $('audVolVal'), pitchVal: $('audPitchVal'), name: $('audName'),
      file: $('audFile'), upload: $('audUpload'), remove: $('audRemove'),
      preview: $('audPreview'), restore: $('audRestore'), status: $('audStatus')
    };
    if (!ui.enabled) return;
    ui.enabled.onchange = function () { S.enabled = ui.enabled.checked; save(); };
    ui.volume.oninput = function () { S.volume = clamp(+ui.volume.value / 100, 0, 1); ui.volVal.textContent = ui.volume.value + '%'; save(); };
    ui.pitch.oninput = function () { S.pitch = clamp(+ui.pitch.value, 0.5, 2); ui.pitchVal.textContent = S.pitch.toFixed(2) + '\u00d7'; save(); };
    ui.upload.onclick = function () { ui.file.click(); };
    ui.file.onchange = function () {
      var f = ui.file.files && ui.file.files[0];
      loadFile(f).then(function () { ui.file.value = ''; });
    };
    ui.remove.onclick = removeCustom;
    ui.preview.onclick = function () { preview(); };
    ui.restore.onclick = restoreDefaults;
    refreshUi(); refreshStatus();
  }

  /* ---------- init ---------- */
  function init() {
    load();
    renderDefault();
    unlockEvents.forEach(function (n) { global.addEventListener(n, onGesture, true); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && ctx && ctx.state !== 'running') { try { ctx.resume().catch(noop); } catch (e) {} }
    });
    bind();
    restoreSaved();
  }

  global.MergeAudio = {
    playMerge: playMerge,
    preview: preview,
    unlock: unlock,
    decodeFile: decodeFile,
    decodeBlob: decodeBlob,
    soundStore: soundStore,
    startRecordingAudio: startRecordingAudio,
    stopRecordingAudio: stopRecordingAudio,
    loadFile: loadFile,
    removeCustom: removeCustom,
    restoreDefaults: restoreDefaults,
    stats: stats,
    settings: S,
    _ctx: function () { return ctx; }
  };

  // The game's script runs before DOMContentLoaded and needs MergeAudio.soundStore at once: it is defined above.
  try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  } catch (e) {}
})(window);
