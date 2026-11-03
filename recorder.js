/* Merge Ball - video recorder (YouTube Shorts format)
 *
 * Renders the game to an off-screen 9:16 canvas (1080x1920 or 720x1280) every
 * frame, captures it with canvas.captureStream(), mixes in the game's audio
 * (merge sounds) and encodes it in the browser with MediaRecorder. The result
 * is saved as MP4 (H.264 + AAC) where the browser supports it, else WebM.
 * Nothing here touches game logic; if recording is unsupported the game is
 * unaffected.
 */
(function (global) {
  'use strict';

  var MAX_SECONDS = 180;           // YouTube Shorts length limit
  var BITRATE = { 1080: 14e6, 720: 7e6 };

  var FORMATS = [
    ['WebM (VP9 + Opus) - high quality, stays in sync', 'video/webm;codecs=vp9,opus'],
    ['WebM (VP8 + Opus)', 'video/webm;codecs=vp8,opus'],
    ['MP4 (H.264 + AAC) - widest compatibility', 'video/mp4;codecs=avc1.640028,mp4a.40.2'],
    ['MP4 (H.264 + AAC) - widest compatibility', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2'],
    ['WebM', 'video/webm']
  ];
  var KEY = 'mergeball.rec.v1';

  var $ = function (id) { return document.getElementById(id); };
  var ui = {}, rec = null, state = null, lastUrl = null;

  function supportedFormats() {
    var out = [], seen = {};
    if (!global.MediaRecorder || !MediaRecorder.isTypeSupported) return out;
    FORMATS.forEach(function (f) {
      var ext = f[1].indexOf('mp4') >= 0 ? 'mp4' : 'webm';
      var fam = ext + (f[1].indexOf('vp9') >= 0 ? '9' : f[1].indexOf('vp8') >= 0 ? '8' : '');
      try { if (MediaRecorder.isTypeSupported(f[1]) && !seen[fam]) { seen[fam] = 1; out.push(f); } } catch (e) {}
    });
    return out;
  }

  function loadPrefs() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (o) {
        if (o.res) ui.res.value = o.res;
        if (o.fps) ui.fps.value = o.fps;
        if (typeof o.delay === 'number') ui.delay.value = Math.min(500, Math.max(0, o.delay));
      }
    } catch (e) {}
  }
  function savePrefs() {
    try { localStorage.setItem(KEY, JSON.stringify({ res: ui.res.value, fps: ui.fps.value, delay: +ui.delay.value })); } catch (e) {}
  }
  function showDelay() { ui.delayVal.textContent = (+ui.delay.value) + ' ms'; }

  function setStatus(msg) { if (ui.status) ui.status.textContent = msg; }
  function fmtTime(s) { return Math.floor(s / 60) + ':' + ('0' + Math.floor(s % 60)).slice(-2); }

  function start() {
    if (rec) return;
    if (!global.MediaRecorder || !HTMLCanvasElement.prototype.captureStream || !global.__mbSetRecTarget) {
      setStatus('Video recording is not supported in this browser. Try Chrome.');
      return;
    }
    var fmt = ui.fmt.value;
    if (!fmt) { setStatus('No supported video format found in this browser.'); return; }
    var size = +ui.res.value === 720 ? 720 : 1080;
    var fps = +ui.fps.value === 30 ? 30 : 60;
    var w = size, h = Math.round(size * 16 / 9);

    // First tap is a user gesture: unlock audio, then begin.
    var unlock = (global.MergeAudio && MergeAudio.unlock) ? MergeAudio.unlock() : Promise.resolve(false);
    unlock.then(function () { begin(fmt, w, h, size, fps); }, function () { begin(fmt, w, h, size, fps); });
  }

  function begin(mime, w, h, size, fps) {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var c2 = canvas.getContext('2d');
      c2.fillStyle = '#000'; c2.fillRect(0, 0, w, h);
      global.__mbSetRecTarget(canvas);                 // game now renders into it every frame

      var vstream = canvas.captureStream(fps);
      var astream = null;
      try { astream = global.MergeAudio && MergeAudio.startRecordingAudio ? MergeAudio.startRecordingAudio(+ui.delay.value || 0) : null; } catch (e) {}
      var tracks = vstream.getVideoTracks().concat(astream ? astream.getAudioTracks() : []);
      var stream = new MediaStream(tracks);

      var opts = { mimeType: mime, videoBitsPerSecond: BITRATE[size] };
      if (astream) opts.audioBitsPerSecond = 192000;
      var mr = new MediaRecorder(stream, opts);
      var startNow = function () { try { mr.start(1000); rec.t0 = Date.now(); } catch (e) { cleanup(); setStatus('Could not start recording.'); } };
      var chunks = [];
      mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = function () { finish(chunks, mr.mimeType || mime); };
      mr.onerror = function () { setStatus('Recording failed.'); cleanup(); };

      rec = { mr: mr, vstream: vstream, t0: Date.now(), hasAudio: !!astream, w: w, h: h, mime: mime, timer: null, wake: null };
      var started = false, go = function () { if (started || !rec) return; started = true; startNow(); };
      var raf = global.requestAnimationFrame;
      if (raf) { raf(function () { raf(go); }); setTimeout(go, 400); } else go();   // 2 frames (or 400 ms if the tab is hidden)

      try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { if (rec) rec.wake = l; else l.release(); }, function () {}); } catch (e) {}
      var panel = $('panel'); if (panel) panel.classList.remove('open');
      ui.float.classList.add('on'); ui.start.disabled = true;
      ui.link.textContent = '';
      setStatus('Recording ' + w + '\u00d7' + h + ' @' + fps + 'fps' + (astream ? ' with sound' : ' (no audio available)') + '...');
      rec.timer = setInterval(tick, 250); tick();
    } catch (e) {
      cleanup();
      setStatus('Could not start recording: ' + (e && e.message ? e.message : e));
    }
  }

  function tick() {
    if (!rec) return;
    var s = (Date.now() - rec.t0) / 1000;
    ui.time.textContent = fmtTime(s);
    if (s >= MAX_SECONDS) stop();
  }

  function stop() {
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    try { if (rec.mr.state !== 'inactive') rec.mr.stop(); else cleanup(); } catch (e) { cleanup(); }
  }

  function cleanup() {
    try { global.__mbSetRecTarget(null); } catch (e) {}
    try { if (global.MergeAudio && MergeAudio.stopRecordingAudio) MergeAudio.stopRecordingAudio(); } catch (e) {}
    if (rec) {
      clearInterval(rec.timer);
      try { rec.vstream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      try { if (rec.wake) rec.wake.release(); } catch (e) {}
    }
    rec = null;
    ui.float.classList.remove('on'); ui.start.disabled = false;
  }

  function finish(chunks, mime) {
    var secs = rec ? (Date.now() - rec.t0) / 1000 : 0;
    var info = rec ? (rec.w + '\u00d7' + rec.h + ', ' + fmtTime(secs)) : '';
    cleanup();
    if (!chunks.length) { setStatus('Nothing was recorded.'); return; }
    var ext = mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
    var blob = new Blob(chunks, { type: mime.split(';')[0] });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    var name = 'merge-ball-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.' + ext;
    var a = document.createElement('a');
    a.href = lastUrl; a.download = name; a.textContent = 'Save ' + name;
    ui.link.textContent = ''; ui.link.appendChild(a);
    document.body.appendChild(a); a.style.display = 'none'; a.click(); a.remove(); a.style.display = '';
    setStatus('Saved (' + info + ', ' + (blob.size / 1048576).toFixed(1) + ' MB). If the download did not start, use the link below.');
    global.__mbLastRecording = { blob: blob, name: name };
  }

  function init() {
    ui = { delay: $('recDelay'), delayVal: $('recDelayVal'), fps: $('recFps'), res: $('recRes'), fmt: $('recFmt'), start: $('recStart'), status: $('recStatus'), link: $('recLink'), float: $('recFloat'), time: $('recTime') };
    if (!ui.start) return;
    var fm = supportedFormats();
    fm.forEach(function (f) { ui.fmt.appendChild(new Option(f[0], f[1])); });
    if (!fm.length || !HTMLCanvasElement.prototype.captureStream) {
      ui.start.disabled = true;
      setStatus('Video recording is not supported in this browser. Try Chrome.');
    }
    loadPrefs(); showDelay();
    ui.delay.oninput = function () { showDelay(); savePrefs(); };
    ui.res.onchange = ui.fps.onchange = savePrefs;
    ui.start.onclick = start;
    ui.float.onclick = stop;
  }

  try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  } catch (e) {}
  global.MergeRecorder = { start: start, stop: stop, isRecording: function () { return !!rec; } };
})(window);
