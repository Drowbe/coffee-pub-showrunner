'use strict';
// The recording toolbar: record, pause and stop, the time, and a level and mute for each sound source, with meters.
const $ = (id) => document.getElementById(id);
let state = null; let shape = ''; let peekWhileRecording = false; // brings the preview back during a recording that hides it
const rowEls = [];

const mmss = (n) => `${Math.floor(n / 3600) ? `${Math.floor(n / 3600)}:` : ''}${String(Math.floor(n / 60) % 60).padStart(Math.floor(n / 3600) ? 2 : 1, '0')}:${String(n % 60).padStart(2, '0')}`;

function sources(s) {
  const list = [];
  // A picture has no sound, so only windows get a level and a meter.
  if (s.layout !== 'cam' && !s.pictures[0]) list.push({ kind: 'w', i: 0, label: s.names[0] || 'Window', meter: 0 });
  if (s.layout === 'side' && !s.pictures[1]) list.push({ kind: 'w', i: 1, label: s.names[1] || 'Second window', meter: 1 });
  if (s.audio.mic.enabled) list.push({ kind: 'm', label: 'Microphone', meter: 2 });
  return list;
}

function build(list) {
  const rows = $('rows'); rows.textContent = ''; rowEls.length = 0;
  for (const src of list) {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = src.label; name.title = src.label;
    const range = document.createElement('input'); range.type = 'range'; range.min = '0'; range.max = '150'; range.setAttribute('aria-label', `${src.label} level`);
    const pct = document.createElement('span'); pct.className = 'pct';
    const mute = document.createElement('button'); mute.className = 'mute'; mute.type = 'button';
    const meter = document.createElement('div'); meter.className = 'meter'; meter.appendChild(document.createElement('i'));
    row.append(name, range, pct, mute, meter); rows.appendChild(row);
    const el = { src, row, range, pct, mute, bar: meter.firstChild };
    range.addEventListener('input', () => change(el, { level: Number(range.value) / 100 }));
    mute.addEventListener('click', () => change(el, { muted: !current(el).muted }));
    rowEls.push(el);
  }
}

const current = (el) => (el.src.kind === 'm' ? state.audio.mic : state.audio.windows[el.src.i]);

function change(el, patch) {
  const next = { windows: state.audio.windows.map((w) => ({ ...w })), mic: { ...state.audio.mic } };
  Object.assign(el.src.kind === 'm' ? next.mic : next.windows[el.src.i], patch);
  state.audio = next;
  window.recbar.setAudio(next);
  paintRows();
}

function paintRows() {
  for (const el of rowEls) {
    const v = current(el);
    if (document.activeElement !== el.range) el.range.value = String(Math.round(v.level * 100));
    el.pct.textContent = `${Math.round(v.level * 100)}%`;
    el.mute.textContent = v.muted ? 'Muted' : 'Mute';
    el.mute.classList.toggle('on', v.muted);
    el.row.classList.toggle('off', v.muted);
  }
}

// A short, quiet tone when the recording really begins, so it is clear when to start speaking.
function readyTone() {
  try {
    const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.frequency.value = 880; gain.gain.value = 0.0001; gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.25); osc.onended = () => ctx.close().catch(() => {});
  } catch (err) { /* no tone */ }
}
let lastState = 'idle';

function render(s) {
  if (lastState === 'starting' && s.state === 'recording') readyTone();
  lastState = s.state;
  state = s;
  const live = s.state === 'recording' || s.state === 'paused';
  const rec = $('rec');
  rec.textContent = live ? 'Stop' : s.state === 'starting' ? 'Starting...' : s.state === 'stopping' ? 'Saving...' : 'Record';
  rec.className = live ? 'stop' : 'go';
  rec.disabled = s.state === 'starting' || s.state === 'stopping';
  $('pause').hidden = !live;
  $('pause').textContent = s.state === 'paused' ? 'Resume' : 'Pause';
  $('time').textContent = mmss(s.seconds);
  const label = s.state === 'starting' ? 'Starting... wait for the tone before you speak' : s.state === 'stopping' ? 'Saving...' : s.state === 'paused' ? 'PAUSED' : live ? 'RECORDING' : s.error ? '' : s.file ? `Saved ${s.file.split(/[\\/]/).pop()}` : 'Ready';
  const note = s.error || s.warning || '';
  const text = note || label;
  const st = $('state'); st.textContent = text; st.title = text; st.className = note ? 'warn' : live ? 'live' : s.state === 'starting' ? 'start' : '';
  $('reveal').hidden = live || !s.file;
  const list = sources(s);
  const key = list.map((x) => `${x.kind}${x.i}${x.label}`).join('|');
  if (key !== shape) { shape = key; build(list); }
  paintRows();
  if (!live) peekWhileRecording = false;
  const shown = Boolean(s.preview) && !(live && s.hidePreviewOnRecord && !peekWhileRecording);
  $('previewBox').hidden = !shown;
  $('previewToggle').classList.toggle('on', shown);
  syncPictures(); syncCam(); syncMic();
  window.recbar.size(Math.ceil(document.body.scrollHeight));
}

// ---- the live picture: each window's latest small picture, the webcam, laid out by the recorder's own code ----
const canvas = $('preview'); const pen = canvas.getContext('2d');
const winPics = [null, null];
const pictureOf = [null, null]; const pictureKey = ['', ''];
// Pictures chosen for a place in the layout come with the state (small), and are drawn like a window's picture.
function syncPictures() {
  for (let i = 0; i < 2; i += 1) {
    const url = state && state.pictures ? state.pictures[i] : null;
    if (!url) { pictureOf[i] = null; pictureKey[i] = ''; continue; }
    if (pictureKey[i] === url) continue;
    pictureKey[i] = url;
    const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); if (pictureKey[i] === url) pictureOf[i] = c; }; img.src = url;
  }
}
const camEl = document.createElement('video'); camEl.muted = true; camEl.playsInline = true;
let camStream = null; let camKey = '';

window.recbar.onFrame(({ i, w, h, buf }) => {
  const data = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
  const px = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  for (let n = 0; n < px.length; n += 1) { const v = px[n]; px[n] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >> 16) & 0xff); } // BGRA to RGBA
  let c = winPics[i];
  if (!c || c.width !== w || c.height !== h) { c = document.createElement('canvas'); c.width = w; c.height = h; winPics[i] = c; }
  c.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
});

// While recording, the picture is the recorder's own (what is really being recorded), and the toolbar lets go of the webcam.
const liveShot = document.createElement('canvas'); liveShot.width = 320; liveShot.height = 180;
let liveAt = 0;
window.recbar.onComposite(({ w, h, buf }) => {
  liveShot.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength), w, h), 0, 0);
  liveAt = Date.now();
});

// The outline of the person, from the recorder (which already has the webcam open), for a blurred background in the preview.
let maskCanvas = null; let maskAt = 0;
window.recbar.onMask(({ w, h, buf }) => {
  if (!maskCanvas || maskCanvas.width !== w || maskCanvas.height !== h) { maskCanvas = document.createElement('canvas'); maskCanvas.width = w; maskCanvas.height = h; }
  const img = new ImageData(w, h);
  for (let i = 0; i < buf.length; i += 1) img.data[i * 4 + 3] = buf[i];
  maskCanvas.getContext('2d').putImageData(img, 0, 0);
  maskAt = Date.now();
});

function stopCam() { if (camStream) camStream.getTracks().forEach((t) => t.stop()); camStream = null; camKey = ''; camEl.srcObject = null; }
async function syncCam() {
  const uses = state && state.preview && !isLive() && ['corner', 'center', 'cam'].includes(state.layout);
  if (!uses) { stopCam(); return; }
  const key = `${state.camera.device}|${state.camera.deviceLabel}`;
  if (key === camKey) return;
  stopCam(); camKey = key;
  try {
    const tries = [];
    if (state.camera.device) tries.push({ deviceId: { exact: state.camera.device } });
    tries.push({});
    for (const t of tries) {
      try { camStream = await navigator.mediaDevices.getUserMedia({ video: { ...t, width: { ideal: 960 } } }); break; } catch (err) { /* try the next */ }
    }
    if (camStream && camKey === key) { camEl.srcObject = camStream; camEl.play().catch(() => {}); }
  } catch (err) { camStream = null; }
}

setInterval(() => {
  if (!state || !state.preview) return;
  if (isLive() && Date.now() - liveAt < 2000) { pen.drawImage(liveShot, 0, 0, canvas.width, canvas.height); return; }
  const shown = [state.layout === 'cam' ? null : (pictureOf[0] || (state.pictures && state.pictures[0] ? null : winPics[0])), state.layout === 'side' ? (pictureOf[1] || (state.pictures && state.pictures[1] ? null : winPics[1])) : null];
  window.ShowrunnerLayout.compose(pen, canvas.width, canvas.height, { layout: state.layout, fit: state.fit, camera: state.camera, sources: shown, camVideo: camEl, camMask: Date.now() - maskAt < 1500 ? maskCanvas : null });
}, 70);

// ---- meters that work before recording: the windows' loudness comes from the app, the microphone is listened to here ----
const paint = (el, peak) => {
  const db = peak > 0 ? 20 * Math.log10(peak) : -90;
  el.bar.style.width = `${Math.round(Math.min(1, Math.max(0, (db + 60) / 60)) * 100)}%`;
  el.bar.className = db > -1 ? 'clip' : db > -9 ? 'hot' : '';
};
const isLive = () => state && (state.state === 'recording' || state.state === 'paused' || state.state === 'starting' || state.state === 'stopping');
window.recbar.onIdle((peaks) => {
  if (!state || isLive()) return;
  for (const el of rowEls) if (el.src.kind === 'w') { const v = current(el); paint(el, v.muted ? 0 : (peaks[el.src.i] || 0) * v.level); }
});
let micMeter = null;
function stopMic() { if (!micMeter) return; clearInterval(micMeter.timer); if (micMeter.stream) micMeter.stream.getTracks().forEach((t) => t.stop()); if (micMeter.ctx) micMeter.ctx.close().catch(() => {}); micMeter = null; }
async function syncMic() {
  const on = state && state.audio.mic.enabled && !isLive();
  if (!on) { stopMic(); const el = rowEls.find((r) => r.src.kind === 'm'); if (el) paint(el, 0); return; }
  const m = state.audio.mic; const key = `${m.device}|${m.deviceLabel}`;
  if (micMeter && micMeter.key === key) return;
  stopMic(); micMeter = { key };
  // Opening can stall (the device is still being let go by the recorder), so it is given a few seconds and then tried again.
  const retry = () => { if (micMeter && micMeter.key === key && !micMeter.stream) { micMeter = null; setTimeout(() => { if (state) syncMic(); }, 1500); } };
  const giveUp = setTimeout(retry, 4000);
  try {
    let stream = null;
    for (const t of m.device ? [{ deviceId: { exact: m.device } }, {}] : [{}]) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { ...t, echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); break; } catch (err) { /* next */ }
    }
    clearTimeout(giveUp);
    if (!stream && micMeter && micMeter.key === key) { retry(); return; }
    if (!stream || !micMeter || micMeter.key !== key) { if (stream) stream.getTracks().forEach((t) => t.stop()); return; }
    const ctx = new AudioContext(); ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(1024); let held = 0; let ticks = 0;
    const timer = setInterval(() => {
      if (isLive()) return;
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i += 1) { const v = Math.abs(buf[i]); if (v > held) held = v; }
      ticks += 1;
      if (ticks % 5 === 0) { const el = rowEls.find((r) => r.src.kind === 'm'); if (el) { const mm = state.audio.mic; paint(el, mm.muted ? 0 : held * mm.level); } held = 0; }
    }, 20);
    micMeter = { key, stream, ctx, timer };
  } catch (err) { clearTimeout(giveUp); micMeter = null; }
}

$('previewToggle').addEventListener('click', () => {
  const live = state && (state.state === 'recording' || state.state === 'paused');
  if (live && state.hidePreviewOnRecord) { peekWhileRecording = !peekWhileRecording; render(state); return; } // only for this recording
  window.recbar.setPreview(!(state && state.preview));
});
window.recbar.onState(render);
window.recbar.onLevels((levels) => { for (const el of rowEls) paint(el, (levels && levels[el.src.meter]) || 0); });
$('rec').addEventListener('click', async () => {
  const live = state && (state.state === 'recording' || state.state === 'paused');
  const result = await window.recbar.action(live ? 'stop' : 'start');
  if (result && result.error) { const st = $('state'); st.textContent = result.error; st.title = result.error; st.className = 'warn'; }
});
$('pause').addEventListener('click', async () => {
  const result = await window.recbar.action(state.state === 'paused' ? 'resume' : 'pause');
  if (result && result.error) { const st = $('state'); st.textContent = result.error; st.title = result.error; st.className = 'warn'; }
});
$('reveal').addEventListener('click', () => window.recbar.reveal());
$('close').addEventListener('click', () => window.recbar.close());
window.recbar.init().then(render);
